import { _decorator, Component, Node, Vec3, Quat, tween } from 'cc';
import { EventBus, GameEvents } from './EventBus';
import { Bobbin } from '../Bobbin';
import { SplineManager } from './SplineManager';
import { QueueManager } from './QueueManager';
import { MapObjectSpawner } from '../MapObjectSpawner';

const { ccclass, property } = _decorator;

/**
 * Hàng đợi tràn — lưu tạm bobbin khi BottomQueue (QueueManager) đầy.
 * Tương đương Unity OverflowQueue.
 *
 * Tự tạo slot node theo layout center-out.
 * Gắn component này lên một node định vị vùng overflow trong scene.
 */
@ccclass('OverflowQueue')
export class OverflowQueue extends Component {
    public static instance: OverflowQueue = null;

    @property public maxCapacity: number = 8;
    @property public slotSpacing: number = 1.0;  // khoảng cách ngang giữa các slot
    @property public arcHeight: number = 2.0;
    @property public arcDuration: number = 0.4;
    @property public overflowScale: number = 0.8; // scale khi ở overflow (giống Unity)

    private _slots: Node[] = [];
    private _occupiedSlots: boolean[] = [];
    private _slotOrder: number[] = [];           // thứ tự center-out fill
    private _bobbins: Bobbin[] = [];
    private _bobbinSlotMap: Map<Bobbin, number> = new Map();
    private _pendingCount: number = 0;

    public get hasSpace(): boolean {
        return this._bobbins.length + this._pendingCount < this.maxCapacity;
    }

    onLoad() {
        if (!OverflowQueue.instance) { OverflowQueue.instance = this; }
        else { this.node.destroy(); return; }
        EventBus.on(GameEvents.ON_BOBBIN_CLICKED, this._onBobbinClicked, this);
    }

    start() {
        this._buildSlots();
        this._buildSlotOrder();
    }

    // ─── Public API ──────────────────────────────────────────────────────────────

    /// Thêm bobbin vào overflow, bay arc về slot center-out. Giống Unity OverflowQueue.AddBobbin.
    public addBobbin(bobbin: Bobbin, onArrived?: () => void) {
        if (!this.hasSpace) { console.warn('[OverflowQueue] Đầy!'); return; }

        const slotIdx = this._findFreeSlot();
        if (slotIdx < 0) return;

        this._occupiedSlots[slotIdx] = true;
        this._bobbinSlotMap.set(bobbin, slotIdx);
        this._pendingCount++;

        bobbin.inOverflow = true;
        bobbin.inQueueRow = false;

        this._flyToSlot(bobbin, this._slots[slotIdx], () => {
            this._pendingCount--;
            this._bobbins.push(bobbin);
            onArrived?.();
        });
    }

    /// Bobbin rời overflow (bị click). Giống Unity OverflowQueue.OnBobbinLeave.
    public onBobbinLeave(bobbin: Bobbin) {
        const slotIdx = this._bobbinSlotMap.get(bobbin);
        if (slotIdx !== undefined) {
            this._occupiedSlots[slotIdx] = false;
            this._bobbinSlotMap.delete(bobbin);
        }
        const idx = this._bobbins.indexOf(bobbin);
        if (idx !== -1) this._bobbins.splice(idx, 1);
    }

    /** Port 1:1 từ Unity OverflowQueue.ForceReleaseSingle.
     *  Tìm bobbin trong _bobbins, giải phóng slot, release về pool. */
    public forceReleaseSingle(bobbin: Bobbin): boolean {
        const idx = this._bobbins.indexOf(bobbin);
        if (idx < 0) return false;
        const slotIdx = this._bobbinSlotMap.get(bobbin);
        if (slotIdx !== undefined) {
            this._occupiedSlots[slotIdx] = false;
            this._bobbinSlotMap.delete(bobbin);
        }
        this._bobbins.splice(idx, 1);
        if (bobbin.node?.isValid) {
            bobbin.node.setScale(Vec3.ZERO);
            MapObjectSpawner.instance.releaseBobbin(bobbin.node);
        }
        return true;
    }

    public resetForNewLevel() {
        this._bobbins = [];
        this._bobbinSlotMap.clear();
        this._occupiedSlots.fill(false);
        this._pendingCount = 0;
    }

    // ─── Private ─────────────────────────────────────────────────────────────────

    private _onBobbinClicked(bobbin: Bobbin) {
        if (!bobbin.inOverflow) return;
        if (!SplineManager.instance?.hasAvailableSlot()) { bobbin.shake(); return; }
        this.onBobbinLeave(bobbin);
        bobbin.inOverflow = false;
        EventBus.emit(GameEvents.ON_BOBBIN_CHECKOUT, bobbin);
    }

    private _flyToSlot(bobbin: Bobbin, slotNode: Node, onArrived: () => void) {
        const startPos = bobbin.node.worldPosition.clone();
        const endPos = slotNode.worldPosition.clone();
        const ctrl = new Vec3(
            (startPos.x + endPos.x) * 0.5,
            Math.max(startPos.y, endPos.y) + this.arcHeight,
            (startPos.z + endPos.z) * 0.5
        );
        const rotFrom = new Quat();
        bobbin.node.getWorldRotation(rotFrom);
        const scaleFrom = bobbin.node.scale.clone();
        const scaleTo = new Vec3(this.overflowScale, this.overflowScale, this.overflowScale);
        const tmpPos = new Vec3();
        const tmpRot = new Quat();
        const temp = { r: 0 };

        tween(temp)
            .to(this.arcDuration, { r: 1 }, {
                onUpdate: () => {
                    if (!bobbin.node?.isValid) return;
                    const t = temp.r, inv = 1 - t;
                    tmpPos.set(
                        inv*inv*startPos.x + 2*inv*t*ctrl.x + t*t*endPos.x,
                        inv*inv*startPos.y + 2*inv*t*ctrl.y + t*t*endPos.y,
                        inv*inv*startPos.z + 2*inv*t*ctrl.z + t*t*endPos.z
                    );
                    bobbin.node.setWorldPosition(tmpPos);
                    // Scale thu nhỏ về overflowScale trong suốt chuyến bay
                    Vec3.lerp(tmpPos, scaleFrom, scaleTo, t);
                    bobbin.node.setScale(tmpPos);
                    // Xoay về identity trong nửa sau
                    const rotT = t < 0.5 ? 0 : (t - 0.5) / 0.5;
                    Quat.slerp(tmpRot, rotFrom, Quat.IDENTITY, rotT);
                    bobbin.node.setWorldRotation(tmpRot);
                }
            })
            .call(() => {
                if (!bobbin.node?.isValid) return;
                bobbin.node.setParent(slotNode, false);
                bobbin.node.setPosition(Vec3.ZERO);
                bobbin.node.setRotation(Quat.IDENTITY);
                bobbin.node.setScale(scaleTo);
                bobbin.isActive = true;
                // Port 1:1 từ Unity Bobbin.FlyToOverflowSlot:870 — reset isCheckedOut để click được lại
                bobbin.isCheckedOut = false;
                onArrived();
            })
            .start();
    }

    /// Tạo slot node tự động, layout center-out dọc theo trục X.
    private _buildSlots() {
        this._occupiedSlots = new Array(this.maxCapacity).fill(false);
        const halfSpan = (this.maxCapacity - 1) * this.slotSpacing * 0.5;
        for (let i = 0; i < this.maxCapacity; i++) {
            const slotNode = new Node(`OverflowSlot_${i}`);
            slotNode.setParent(this.node);
            slotNode.setPosition(i * this.slotSpacing - halfSpan, 0, 0);
            this._slots.push(slotNode);
        }
    }

    /// Tính thứ tự fill center-out (giống Unity OverflowQueue._slotOrder).
    private _buildSlotOrder() {
        this._slotOrder = new Array(this.maxCapacity);
        const mid = Math.floor(this.maxCapacity / 2);
        if (this.maxCapacity % 2 === 1) {
            this._slotOrder[0] = mid;
            for (let i = 1; i < this.maxCapacity; i++) {
                const offset = Math.floor((i + 1) / 2);
                this._slotOrder[i] = i % 2 === 1 ? mid - offset : mid + offset;
            }
        } else {
            for (let i = 0; i < this.maxCapacity; i++) {
                const offset = Math.floor(i / 2);
                this._slotOrder[i] = i % 2 === 0 ? mid - 1 - offset : mid + offset;
            }
        }
    }

    private _findFreeSlot(): number {
        for (let i = 0; i < this.maxCapacity; i++) {
            const slotIdx = this._slotOrder[i];
            if (!this._occupiedSlots[slotIdx]) return slotIdx;
        }
        return -1;
    }
}
