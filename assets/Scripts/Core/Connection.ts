import { _decorator, Component, Color, Vec3 } from 'cc';
import { Bobbin } from '../Bobbin';
import { ConnectionChild } from '../ConnectionChild';
import { MapObjectSpawner } from '../MapObjectSpawner';
import { EventBus, GameEvents } from './EventBus';
import { SplineManager } from './SplineManager';
import { LevelManager } from './LevelManager';
import { QueueManager } from './QueueManager';
import { OverflowQueue } from './OverflowQueue';
import { TrayManager } from './TrayManager';

const { ccclass, property } = _decorator;

/**
 * Port 1:1 từ Unity Connection.cs.
 *
 * Một nhóm bobbin liên kết với nhau. Tất cả members phải "effectively active"
 * thì mới cho phép checkout đồng loạt.
 */
@ccclass('Connection')
export class Connection extends Component {

    /** Tất cả bobbin trong cluster. */
    public members: Bobbin[] = [];

    /** Mảng scales round-robin cho ConnectionChild — tránh visual phình to khi khoảng cách lớn. */
    @property({ type: [Number] })
    public scales: number[] = [];

    private _children: ConnectionChild[] = [];
    private _childBobbins: Array<[Bobbin, Bobbin]> = [];
    private _indexScale: number = 0;

    // ─── Setup ───────────────────────────────────────────────────────────────────

    /**
     * Gọi bởi MapGenerator sau khi spawn bobbin.
     * @param members - tất cả bobbin trong cluster.
     * @param pairs   - các cặp bobbin cần nối bằng cylinder (1 pair = 1 ConnectedShooterData).
     */
    public setup(members: Bobbin[], pairs: Array<[Bobbin, Bobbin]>): void {
        this._indexScale = 0;
        this.members = members.slice();
        for (const b of this.members) b.connection = this;

        this._children = [];
        this._childBobbins = [];

        for (const [a, b] of pairs) {
            if (!a.center || !b.center) continue;
            const rope = MapObjectSpawner.instance.getConnectionChild(this.node);
            if (!rope) continue;

            const scale = this._getScale();
            rope.node.setScale(new Vec3(scale, 1, scale));
            rope.pointA = a.center;
            rope.pointB = b.center;

            rope.setColors(this._getColor(b), this._getColor(a));

            this._children.push(rope);
            this._childBobbins.push([a, b]);
        }
    }

    /** Refresh màu các cylinder khi 1 member chuyển active/inactive. */
    public refreshColor(b: Bobbin): void {
        for (let i = 0; i < this._children.length; i++) {
            const rope = this._children[i];
            if (!rope) continue;
            const [a, c] = this._childBobbins[i];
            if (!a || !c) continue;
            if (a !== b && c !== b) continue;
            rope.setColors(this._getColor(c), this._getColor(a));
        }
    }

    /** Unity dùng activeVisual.material.color / inactiveVisual.material.color.
     *  Cocos: bobbin.currentColor đã sync sẵn ở cả 2 visual qua Bobbin.setColor. */
    private _getColor(b: Bobbin): Color {
        const out = new Color();
        out.set(b.currentColor);
        return out;
    }

    // ─── Checkout Logic ───────────────────────────────────────────────────────────

    /** True nếu tất cả members đã có score = 0 và đang chờ nhau hoàn thành. */
    public allMembersPendingComplete(): boolean {
        for (const b of this.members)
            if (!b.pendingConnectionComplete) return false;
        return true;
    }

    /** True nếu tất cả members đều effectively active VÀ belt còn đủ slot cho cả nhóm
     *  VÀ TrayManager còn đủ tray rảnh (tránh partial checkout khi tray đang return). */
    public canCheckout(): boolean {
        const sm = SplineManager.instance;
        if (!sm) return false;
        if (sm.availableSlots < this.members.length) return false;
        // Port từ Unity OnClick: HasAvailableTray check → ở đây mở rộng cho cluster
        // bằng cách yêu cầu đủ tray cho tất cả member, tránh member đầu lấy được tray
        // nhưng member sau shake vì tray cuối đang bay về (_returningCount).
        const tm = TrayManager.instance;
        if (!tm || tm.availableTrayCount < this.members.length) return false;
        for (const b of this.members) {
            if (b.isCheckedOut) return false;
            if (!b.isEffectivelyActiveForConnection(this)) return false;
        }
        return true;
    }

    /** Gửi toàn bộ members lên belt. */
    public checkoutAll(): void {
        // Sort theo vị trí trong queue row (index nhỏ = head = xử lý trước).
        // Đảm bảo head luôn được activate trước khi non-head bay lên.
        const sorted = this.members.slice();
        const lm = LevelManager.instance;
        const indexCache: Map<Bobbin, number> = new Map();
        for (const b of sorted) indexCache.set(b, lm ? lm.getQueueRowIndex(b) : Number.MAX_SAFE_INTEGER);
        sorted.sort((a, b) => (indexCache.get(a) ?? Number.MAX_SAFE_INTEGER) - (indexCache.get(b) ?? Number.MAX_SAFE_INTEGER));

        for (const b of sorted) {
            this._tryCheckoutMember(b);
        }
    }

    /** Checkout 1 member trong cluster — bypass active-state check (đã được CanCheckout đảm bảo).
     *  Port 1:1 từ Unity Bobbin.TryCheckout:197-217:
     *    isCheckedOut=true → onBobbinLeave (queue/overflow/queueManager) → center=(0,0,0) → fly.
     *  KHÔNG gọi setActiveState(false) — Unity giữ _isActive nguyên (bobbin trên belt vẫn active). */
    private _tryCheckoutMember(b: Bobbin): void {
        if (b.isCheckedOut) return;
        b.isCheckedOut = true;

        // Tách bobbin khỏi grid queue/queue/overflow tương ứng — bypass click check
        if (b.inQueueRow) {
            LevelManager.instance?.onBobbinLeave(b);
        } else if (b.inOverflow) {
            OverflowQueue.instance?.onBobbinLeave?.(b);
        } else {
            QueueManager.instance?.onBobbinLeave(b);
        }
        // Port Unity TryCheckout:213 — reset center về origin trước khi fly,
        // tránh offset -0.1 (do setActiveState(false) trước đây trên queue) làm rope lệch.
        if (b.center) b.center.setPosition(0, 0, 0);
        EventBus.emit(GameEvents.ON_BOBBIN_CHECKOUT, b);
    }

    // ─── SuperBobbin purge ────────────────────────────────────────────────────────

    /**
     * Xóa ConnectionChild của các bobbin có material khớp.
     * Nếu sau đó không còn child nào, release toàn bộ Connection về pool.
     */
    public purgeMaterial(material: number): void {
        const toRemove: Bobbin[] = [];
        for (const b of this.members)
            if (b && b.data && b.data.material === material)
                toRemove.push(b);

        if (toRemove.length === 0) return;

        for (let i = this._children.length - 1; i >= 0; i--) {
            const [a, b] = this._childBobbins[i];
            if (toRemove.indexOf(a) >= 0 || toRemove.indexOf(b) >= 0) {
                MapObjectSpawner.instance.releaseConnectionChild(this._children[i]);
                this._children.splice(i, 1);
                this._childBobbins.splice(i, 1);
            }
        }

        for (const b of toRemove) {
            const idx = this.members.indexOf(b);
            if (idx >= 0) this.members.splice(idx, 1);
            if (b) b.connection = null;
        }

        if (this._children.length === 0) {
            // Không còn pair nào — release các member còn score=0 (đang chờ connection complete)
            for (let i = this.members.length - 1; i >= 0; i--) {
                const b = this.members[i];
                if (!b) continue;
                b.connection = null;
                if ((b.data?.ammo ?? 1) === 0) {
                    this.members.splice(i, 1);
                    Connection._forceReleaseBobbin(b);
                }
            }
            for (const b of this.members) if (b) b.connection = null;
            this.members = [];
            MapObjectSpawner.instance.releaseConnection(this.node);
        } else {
            // Vẫn còn pair — nếu mọi member còn lại đã score=0 thì release toàn cluster
            let allZero = this.members.length > 0;
            for (const b of this.members) {
                if (b && (b.data?.ammo ?? 1) > 0) { allZero = false; break; }
            }
            if (allZero) {
                for (let i = this._children.length - 1; i >= 0; i--)
                    MapObjectSpawner.instance.releaseConnectionChild(this._children[i]);
                this._children = [];
                this._childBobbins = [];

                for (const b of this.members) {
                    if (!b) continue;
                    b.connection = null;
                    Connection._forceReleaseBobbin(b);
                }
                this.members = [];
                MapObjectSpawner.instance.releaseConnection(this.node);
            }
        }
    }

    /** Port 1:1 từ Unity Connection.ForceReleaseBobbin — chain priority:
     *  SplineManager (đang bay/trên belt) → QueueManager (bottom queue) →
     *  OverflowQueue → LevelManager (grid queue). Mỗi manager tự cleanup state nội bộ
     *  + dồn hàng + release pool. Fallback: release thẳng nếu không match container nào. */
    private static _forceReleaseBobbin(b: Bobbin): void {
        if (!b?.node?.isValid) return;
        if (SplineManager.instance?.forceReleaseSingle(b)) return;
        if (QueueManager.instance?.forceReleaseSingle(b)) return;
        if (OverflowQueue.instance?.forceReleaseSingle(b)) return;
        if (LevelManager.instance?.forceReleaseSingleFromRowQueue(b)) return;
        b.node.setScale(Vec3.ZERO);
        MapObjectSpawner.instance.releaseBobbin(b.node);
    }

    // ─── Pool Reset ───────────────────────────────────────────────────────────────

    public resetForPool(): void {
        for (const child of this._children)
            MapObjectSpawner.instance.releaseConnectionChild(child);
        this._children = [];
        this._childBobbins = [];

        for (const b of this.members) if (b) b.connection = null;
        this.members = [];
        this._indexScale = 0;
    }

    private _getScale(): number {
        if (!this.scales || this.scales.length === 0) return 1;
        if (this._indexScale >= this.scales.length) this._indexScale = 0;
        const v = this.scales[this._indexScale];
        this._indexScale++;
        return v;
    }
}
