import { _decorator, Component, Node, Vec3, Quat, tween } from 'cc';
import { EventBus, GameEvents } from './EventBus';
import { Bobbin } from '../Bobbin';
import { SplineManager } from './SplineManager';
import { QueueSlot } from '../QueueSlot';
import { MapObjectSpawner } from '../MapObjectSpawner';

const { ccclass, property } = _decorator;

/**
 * Bottom Queue — hàng đợi phía dưới màn hình, chứa bobbin sau khi từ belt trả về.
 * Tương đương Unity QueueManager (với _slots là List<Transform> từ QueueSlot).
 *
 * Cần setup trong scene: đặt các node con QueueSlot dưới node này,
 * mỗi QueueSlot có một child node "positionBobbin" làm điểm đỗ của bobbin.
 */
@ccclass('QueueManager')
export class QueueManager extends Component {
    public static instance: QueueManager = null;

    @property public arcHeight: number = 2.0;
    @property public arcDuration: number = 0.4;
    @property public shiftDuration: number = 0.25;
    @property public shiftHopHeight: number = 0.4;

    private _slots: Node[] = [];          // positionBobbin của từng QueueSlot
    private _queued: Bobbin[] = [];       // bobbins đã đáp xuống và đang đứng trong hàng
    private _returningCount: number = 0;  // bobbins đang bay về (chưa đáp)

    public get hasFreeSlot(): boolean {
        return this._queued.length + this._returningCount < this._slots.length;
    }

    onLoad() {
        if (!QueueManager.instance) { QueueManager.instance = this; }
        else { this.node.destroy(); return; }
        EventBus.on(GameEvents.ON_BOBBIN_CLICKED, this._onBobbinClicked, this);
    }

    start() {
        // Thu thập tất cả QueueSlot con (giống Unity GetComponentsInChildren<QueueSlot>)
        const slots = this.getComponentsInChildren(QueueSlot);
        for (const slot of slots) {
            if (slot.positionBobbin) this._slots.push(slot.positionBobbin);
        }
    }

    public resetForNewLevel() {
        this._queued = [];
        this._returningCount = 0;
    }

    // ─── Public API ──────────────────────────────────────────────────────────────

    /**
     * Bobbin từ belt trả về → bay arc vào slot cuối hàng.
     * Trả false nếu hàng đầy → caller nên thử OverflowQueue.
     * Giống Unity QueueManager.TryReturn.
     */
    public tryReturn(bobbin: Bobbin): boolean {
        if (!this.hasFreeSlot) return false;

        const targetIdx = Math.min(
            this._queued.length + this._returningCount,
            this._slots.length - 1
        );
        this._returningCount++;

        this._flyToSlot(bobbin, this._slots[targetIdx], () => {
            this._returningCount--;
            // Port 1:1 từ Unity: nếu connection đã complete trong lúc bobbin đang bay về
            // → complete + destroy thay vì vào queue (giống Bobbin.MarkForCompletion).
            if (bobbin.markedForCompletion) {
                if (bobbin.node?.isValid) {
                    tween(bobbin.node).to(0.2, { scale: Vec3.ZERO })
                        .call(() => {
                            if (bobbin.node?.isValid) MapObjectSpawner.instance.releaseBobbin(bobbin.node);
                        }).start();
                }
                return;
            }
            this._queued.push(bobbin);
            this._repackQueue(bobbin); // skip hop cho bobbin vừa đáp
        });
        return true;
    }

    /// Bobbin rời hàng (bị click hoặc xóa). Giống Unity QueueManager.OnBobbinLeave.
    public onBobbinLeave(bobbin: Bobbin) {
        const idx = this._queued.indexOf(bobbin);
        if (idx !== -1) {
            this._queued.splice(idx, 1);
            this._repackQueue();
        }
    }

    /** True nếu bobbin đã đáp xuống bottom queue (port 1:1 từ Unity QueueManager.IsQueued). */
    public isQueued(bobbin: Bobbin): boolean {
        return this._queued.indexOf(bobbin) >= 0;
    }

    /** Port 1:1 từ Unity QueueManager.ForceReleaseSingle.
     *  Tìm bobbin trong _queued, splice, release pool, repack. */
    public forceReleaseSingle(bobbin: Bobbin): boolean {
        const idx = this._queued.indexOf(bobbin);
        if (idx < 0) return false;
        this._queued.splice(idx, 1);
        if (bobbin.node?.isValid) {
            bobbin.node.setScale(Vec3.ZERO);
            MapObjectSpawner.instance.releaseBobbin(bobbin.node);
        }
        this._repackQueue();
        return true;
    }

    // ─── Private ─────────────────────────────────────────────────────────────────

    private _onBobbinClicked(bobbin: Bobbin) {
        // Chỉ xử lý bobbin đang ở bottom queue
        if (bobbin.inQueueRow || bobbin.inOverflow) return;
        // Không phải bobbin trong _queued của ta thì bỏ qua
        if (this._queued.indexOf(bobbin) === -1) return;

        if (!SplineManager.instance?.hasAvailableSlot()) { bobbin.shake(); return; }

        this.onBobbinLeave(bobbin);
        EventBus.emit(GameEvents.ON_BOBBIN_CHECKOUT, bobbin);
    }

    /// Bay arc Bezier từ vị trí hiện tại về slot, reset trạng thái khi đáp.
    /// Giống Unity Bobbin.FlyToQueueSlotRoutine.
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
                    // Xoay về identity trong nửa sau chuyến bay (giống Unity FlyToQueueSlotRoutine)
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
                bobbin.node.setScale(Vec3.ONE);
                bobbin.inQueueRow = false;
                bobbin.inOverflow = false;
                bobbin.isActive = true;
                // Port 1:1 từ Unity Bobbin.FlyToQueueSlotRoutine:816 — reset isCheckedOut khi đáp xuống queue
                // để click được lại lần sau (đặc biệt quan trọng cho bobbin trong connection cluster).
                bobbin.isCheckedOut = false;
                bobbin.updateOriginPos();
                // Hiện lại score1 khi đáp xuống bottom queue (giống Unity FlyToQueueSlotRoutine)
                if (bobbin.score1) bobbin.score1.node.active = true;
                if (bobbin.score2) bobbin.score2.node.active = false;
                onArrived();
            })
            .start();
    }

    /// Dồn các bobbin trong hàng về đúng slot sau khi có người rời/tham gia.
    /// Giống Unity QueueManager.RepackQueue + ShiftRoutine.
    private _repackQueue(skipHopFor?: Bobbin) {
        for (let i = 0; i < this._queued.length; i++) {
            const bobbin = this._queued[i];
            if (!bobbin?.node?.isValid) continue;
            const slot = this._slots[i];
            if (!slot) continue;
            if (bobbin.node.parent === slot) continue; // đã đúng chỗ

            this._shiftBobbin(bobbin, slot, bobbin !== skipHopFor);
        }
    }

    private _shiftBobbin(bobbin: Bobbin, slot: Node, hop: boolean) {
        const fromPos = bobbin.node.worldPosition.clone();
        const toPos = slot.worldPosition.clone();
        const ctrlY = hop
            ? Math.max(fromPos.y, toPos.y) + this.shiftHopHeight
            : (fromPos.y + toPos.y) * 0.5;
        const ctrl = new Vec3((fromPos.x + toPos.x) * 0.5, ctrlY, (fromPos.z + toPos.z) * 0.5);

        bobbin.node.setParent(this.node, true);
        const temp = { r: 0 };
        const tmp = new Vec3();
        tween(temp)
            .to(this.shiftDuration, { r: 1 }, {
                onUpdate: () => {
                    if (!bobbin.node?.isValid) return;
                    const t = temp.r, inv = 1 - t;
                    tmp.set(
                        inv*inv*fromPos.x + 2*inv*t*ctrl.x + t*t*toPos.x,
                        inv*inv*fromPos.y + 2*inv*t*ctrl.y + t*t*toPos.y,
                        inv*inv*fromPos.z + 2*inv*t*ctrl.z + t*t*toPos.z
                    );
                    bobbin.node.setWorldPosition(tmp);
                }
            })
            .call(() => {
                if (!bobbin.node?.isValid) return;
                bobbin.node.setParent(slot, false);
                bobbin.node.setPosition(Vec3.ZERO);
                bobbin.updateOriginPos();
            })
            .start();
    }
}
