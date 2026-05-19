import { _decorator, Component, Vec3, tween } from 'cc';
import { EventBus, GameEvents } from './EventBus';
import { Bobbin } from '../Bobbin';
import { Lock } from '../Lock';
import { Pipe } from '../Pipe';
import { SplineManager } from './SplineManager';
import { Connection } from './Connection';
import { MapObjectSpawner } from '../MapObjectSpawner';
import { QueueItem, QueueItemType } from './QueueItem';

const { ccclass, property } = _decorator;

/**
 * Quản lý lifecycle level và grid queue heterogeneous (Bobbin/Lock/Pipe/Mover).
 * Port 1:1 từ Unity LevelManager._rowQueues = List<List<QueueItem>>.
 */
@ccclass('LevelManager')
export class LevelManager extends Component {
    public static instance: LevelManager = null;

    @property public queueShiftDuration: number = 0.3;
    @property public queueJumpHeight: number = 0.3;
    @property public queueDipHeight: number = 0.08;
    @property public queueDipRatio: number = 0.25;

    // ─── Unified queue (port 1:1 từ Unity LevelManager._rowQueues) ──────────────
    // Mỗi row là một cột QueueItem (có thể là Bobbin/Lock/Pipe/Mover).
    // row[0] = item đầu hàng (head — chặn click nếu là Lock).
    private _rowQueues: QueueItem[][] = [];
    private _rowBaseX: number[] = [];
    private _rowBaseZ: number[] = [];
    private _rowSpacing: number = 0.15;

    /** Track tween shift đang chạy cho từng QueueItem — stop trước khi start tween mới.
     *  Tránh race khi cluster checkout xoá nhiều member cùng row liên tiếp. */
    private _shiftTweens: Map<QueueItem, any> = new Map();

    onLoad() {
        if (!LevelManager.instance) { LevelManager.instance = this; }
        else { this.node.destroy(); return; }
        EventBus.on(GameEvents.ON_BOBBIN_CLICKED, this._onBobbinClicked, this);
    }

    // ─── Setup (gọi từ MapGenerator khi spawn bobbin) ────────────────────────────

    public setupRows(rowCount: number) {
        this._rowQueues = [];
        this._rowBaseX = [];
        this._rowBaseZ = [];
        for (let i = 0; i < rowCount; i++) {
            this._rowQueues.push([]);
            this._rowBaseX.push(0);
            this._rowBaseZ.push(0);
        }
    }

    /** Thêm bobbin vào row dưới dạng QueueItem.fromBobbin. Ghi nhận base position. */
    public addBobbinToRow(rowIdx: number, bobbin: Bobbin) {
        if (rowIdx < 0 || rowIdx >= this._rowQueues.length) return;
        const row = this._rowQueues[rowIdx];

        if (row.length === 0) {
            this._rowBaseX[rowIdx] = bobbin.node.position.x;
            this._rowBaseZ[rowIdx] = bobbin.node.position.z;
        } else if (row.length === 1) {
            const measured = bobbin.node.position.z - this._rowBaseZ[rowIdx];
            if (measured > 0) this._rowSpacing = measured;
        }

        bobbin.inQueueRow = true;
        row.push(QueueItem.fromBobbin(bobbin));
    }

    /** Thay thế Bobbin trong row bằng Lock (in-place). Port từ Unity SpawnLocks.
     *  Trả về true nếu thay thế thành công, false nếu không tìm thấy bobbin. */
    public replaceBobbinWithLock(bobbin: Bobbin, lockComp: Lock): boolean {
        for (let r = 0; r < this._rowQueues.length; r++) {
            const idx = this._findBobbinIndex(this._rowQueues[r], bobbin);
            if (idx < 0) continue;
            // Reset bobbin's queue state vì nó không còn trong queue nữa
            bobbin.inQueueRow = false;
            this._rowQueues[r][idx] = QueueItem.fromLock(lockComp);
            return true;
        }
        return false;
    }

    /** Thay thế Bobbin trong row bằng Pipe (in-place). Port từ Unity SpawnPipes. */
    public replaceBobbinWithPipe(bobbin: Bobbin, pipe: Pipe): boolean {
        for (let r = 0; r < this._rowQueues.length; r++) {
            const idx = this._findBobbinIndex(this._rowQueues[r], bobbin);
            if (idx < 0) continue;
            bobbin.inQueueRow = false;
            this._rowQueues[r][idx] = QueueItem.fromPipe(pipe);
            return true;
        }
        return false;
    }

    /** Bật/tắt active state sau khi spawn xong. Chỉ Bobbin items được toggle state. */
    public initQueueStates() {
        for (let r = 0; r < this._rowQueues.length; r++) {
            this._cleanRow(r);
            const row = this._rowQueues[r];
            for (let i = 0; i < row.length; i++) {
                const item = row[i];
                if (item.type === QueueItemType.Bobbin && item.bobbin) {
                    // Bobbin chỉ active nếu nó là head VÀ phía trước không có Lock
                    item.bobbin.setActiveState(i === 0);
                }
            }
        }
    }

    // ─── Queue departure (port 1:1 từ Unity OnBobbinLeaveQueue) ─────────────────

    /** Gọi khi bobbin rời hàng (bị rút bởi booster/cluster, không qua click). */
    public onBobbinLeave(bobbin: Bobbin) {
        for (let r = 0; r < this._rowQueues.length; r++) {
            const idx = this._findBobbinIndex(this._rowQueues[r], bobbin);
            if (idx === -1) continue;
            const departedPos = bobbin.node.worldPosition.clone();
            this._rowQueues[r].splice(idx, 1);
            bobbin.inQueueRow = false;
            // Nếu sau splice, head mới là Pipe → trigger sinh bobbin tại departedPos.
            if (idx === 0 && this._tryTriggerPipeAtHead(r, departedPos)) return;
            this._shiftRow(r);
            return;
        }
    }

    // ─── Connection helpers (port 1:1 từ Unity LevelManager) ────────────────────

    /** True nếu bobbin có thể tham gia checkout cluster Connection:
     *  - Không có Lock nào đứng trước nó.
     *  - Mọi Bobbin trước nó đều thuộc cùng connection.
     *  Port 1:1 từ Unity IsBobbinEffectivelyActive. */
    public isBobbinEffectivelyActive(bobbin: Bobbin, conn: Connection): boolean {
        for (const row of this._rowQueues) {
            const idx = this._findBobbinIndex(row, bobbin);
            if (idx < 0) continue;
            for (let i = 0; i < idx; i++) {
                const item = row[i];
                if (item.type === QueueItemType.Lock) return false;
                if (item.type === QueueItemType.Bobbin && item.bobbin && item.bobbin.connection !== conn) return false;
            }
            return true;
        }
        return false;
    }

    /** Trả về index của bobbin trong row (dùng cho Connection.checkoutAll sort head-first). */
    public getQueueRowIndex(bobbin: Bobbin): number {
        for (const row of this._rowQueues) {
            const idx = this._findBobbinIndex(row, bobbin);
            if (idx >= 0) return idx;
        }
        return Number.MAX_SAFE_INTEGER;
    }

    /** Port 1:1 từ Unity ForceReleaseSingleFromRowQueue.
     *  Tìm bobbin, splice QueueItem, release pool, dồn các item còn lại. */
    public forceReleaseSingleFromRowQueue(bobbin: Bobbin): boolean {
        for (let r = 0; r < this._rowQueues.length; r++) {
            const row = this._rowQueues[r];
            const idx = this._findBobbinIndex(row, bobbin);
            if (idx < 0) continue;
            const item = row[idx];
            row.splice(idx, 1);
            bobbin.inQueueRow = false;
            const shift = this._shiftTweens.get(item);
            if (shift) { shift.stop(); this._shiftTweens.delete(item); }
            if (bobbin.node?.isValid) {
                bobbin.node.setScale(Vec3.ZERO);
                MapObjectSpawner.instance.releaseBobbin(bobbin.node);
            }
            this._shiftRow(r);
            return true;
        }
        return false;
    }

    // ─── Lock / Key support (port 1:1 từ Unity TryFindHeadLock + UnlockRow) ────

    /** Tìm row đầu tiên có Lock đứng head và chưa được reserve.
     *  Return: { rowIdx, worldPos } hoặc null. Tự gọi lock.reserve() khi trả về. */
    public tryFindHeadLock(): { rowIdx: number; worldPos: Vec3 } | null {
        for (let i = 0; i < this._rowQueues.length; i++) {
            const row = this._rowQueues[i];
            if (row.length === 0) continue;
            const head = row[0];
            if (head.type !== QueueItemType.Lock || !head.lock) continue;
            if (head.lock.isReserved) continue;
            head.lock.reserve();
            return { rowIdx: i, worldPos: head.lock.node.worldPosition.clone() };
        }
        return null;
    }

    /** Mở khóa hàng tại rowIdx: splice Lock, release pool, activate head mới, cascade shift.
     *  Port 1:1 từ Unity UnlockRow. Nếu head mới sau khi xóa Lock là Pipe → trigger spawn. */
    public unlockRow(rowIdx: number): void {
        if (rowIdx < 0 || rowIdx >= this._rowQueues.length) return;
        const row = this._rowQueues[rowIdx];
        if (row.length === 0 || row[0].type !== QueueItemType.Lock) return;

        const lockComp = row[0].lock;
        const lockPos = lockComp?.node?.worldPosition.clone() ?? new Vec3();
        if (lockComp?.node?.isValid) {
            MapObjectSpawner.instance.releaseLock(lockComp.node);
        }
        row.splice(0, 1);
        // Nếu sau splice, head mới là Pipe → trigger sinh bobbin tại lockPos.
        if (this._tryTriggerPipeAtHead(rowIdx, lockPos)) return;
        // Cascade shift tất cả items còn lại lên phía trước
        this._shiftRow(rowIdx);
    }

    // ─── Pipe trigger (port 1:1 từ Unity HandlePipeTrigger) ─────────────────────

    /** Kiểm tra nếu sau splice, head mới là Pipe → gọi handlePipeTrigger. Trả true nếu đã xử lý. */
    private _tryTriggerPipeAtHead(rowIdx: number, gapPos: Vec3): boolean {
        const row = this._rowQueues[rowIdx];
        if (row.length === 0) return false;
        const head = row[0];
        if (head.type !== QueueItemType.Pipe || !head.pipe) return false;
        this._handlePipeTrigger(rowIdx, gapPos);
        return true;
    }

    /** Pipe trở thành head → sinh bobbin mới (nếu còn) bay tới gapPos. Hết queue → release. */
    private _handlePipeTrigger(rowIdx: number, gapPos: Vec3): void {
        const row = this._rowQueues[rowIdx];
        const pipe = row[0].pipe;
        if (!pipe) return;

        // 1. Spawn next bobbin nếu còn queue
        if (pipe.hasMoreBobbin()) {
            const parent = pipe.node.parent ?? this.node;
            const pipeWorldPos = pipe.node.worldPosition;
            const nb = pipe.spawnNextBobbin(parent, pipeWorldPos);
            if (nb) {
                // Insert bobbin mới làm head, pipe lùi xuống idx 1.
                row.splice(0, 0, QueueItem.fromBobbin(nb));
                nb.setInQueueRow(true);
                nb.setActiveState(true);
                nb.beginSpawnFromPipe(gapPos);
            }
        }

        // 2. Nếu hết queue sau consume → shrink + release pipe + cascade shift
        if (!pipe.hasMoreBobbin()) {
            const pipeIdx = row.findIndex(item => item.type === QueueItemType.Pipe);
            if (pipeIdx < 0) return;
            pipe.shrinkAndRelease(() => {
                if (pipe?.node?.isValid) MapObjectSpawner.instance.releasePipe(pipe);
            });
            row.splice(pipeIdx, 1);
            this._shiftRow(rowIdx);
            // Activate head mới nếu là Bobbin (vd. khi pipe là item duy nhất ở đầu, không spawn bobbin)
            if (pipeIdx === 0 && row.length > 0 && row[0].type === QueueItemType.Bobbin && row[0].bobbin) {
                row[0].bobbin.setActiveState(true);
            }
        }
    }

    // ─── Private ─────────────────────────────────────────────────────────────────

    private _findBobbinIndex(row: QueueItem[], bobbin: Bobbin): number {
        for (let i = 0; i < row.length; i++) {
            const item = row[i];
            if (item.type === QueueItemType.Bobbin && item.bobbin === bobbin) return i;
        }
        return -1;
    }

    private _onBobbinClicked(bobbin: Bobbin) {
        if (!bobbin.inQueueRow) return;
        if (!bobbin.isActive) { bobbin.shake(); return; }
        if (!SplineManager.instance?.hasAvailableSlot()) { bobbin.shake(); return; }

        for (let r = 0; r < this._rowQueues.length; r++) {
            const row = this._rowQueues[r];
            const idx = this._findBobbinIndex(row, bobbin);
            if (idx === -1) continue;
            // Chặn click nếu có Lock đứng trước trong hàng (port từ Unity behavior)
            for (let i = 0; i < idx; i++) {
                if (row[i].type === QueueItemType.Lock) { bobbin.shake(); return; }
            }
            const departedPos = bobbin.node.worldPosition.clone();
            row.splice(idx, 1);
            bobbin.inQueueRow = false;
            bobbin.setActiveState(false);
            // Nếu sau splice, head mới là Pipe → trigger sinh bobbin tại departedPos.
            if (idx === 0 && this._tryTriggerPipeAtHead(r, departedPos)) {
                EventBus.emit(GameEvents.ON_BOBBIN_CHECKOUT, bobbin);
                return;
            }
            this._shiftRow(r);
            break;
        }

        EventBus.emit(GameEvents.ON_BOBBIN_CHECKOUT, bobbin);
    }

    /** Dồn tất cả items trong row về đúng slot. Port từ Unity ShiftRow.
     *  Lock cũng được dời vị trí, nhưng KHÔNG gọi setActiveState (chỉ Bobbin có state). */
    private _shiftRow(rowIdx: number) {
        const row = this._rowQueues[rowIdx];
        const baseX = this._rowBaseX[rowIdx];
        const baseZ = this._rowBaseZ[rowIdx];

        for (let i = 0; i < row.length; i++) {
            const item = row[i];
            const node = item.node;
            if (!node?.isValid) continue;

            const targetPos = new Vec3(baseX, 0, baseZ + i * this._rowSpacing);

            // Chỉ Bobbin mới toggle active state — Lock không có active concept.
            if (item.type === QueueItemType.Bobbin && item.bobbin) {
                // Bobbin chỉ active nếu là head VÀ không có Lock đứng trước
                // (i === 0 → là head; nếu phía trước có Lock thì shake/inactive)
                const hasLockBefore = this._hasLockBefore(row, i);
                item.bobbin.setActiveState(i === 0 && !hasLockBefore);
            }

            const fromPos = node.position.clone();
            const isHead = i === 0;
            const ctrlY = isHead
                ? Math.max(fromPos.y, targetPos.y) + this.queueJumpHeight
                : (fromPos.y + targetPos.y) * 0.5;
            const ctrl = new Vec3(
                (fromPos.x + targetPos.x) * 0.5,
                ctrlY,
                (fromPos.z + targetPos.z) * 0.5,
            );

            const existing = this._shiftTweens.get(item);
            if (existing) existing.stop();

            const temp = { r: 0 };
            const tmp = new Vec3();
            const tw = tween(temp)
                .to(this.queueShiftDuration, { r: 1 }, {
                    onUpdate: () => {
                        if (!node?.isValid) return;
                        const t = temp.r, inv = 1 - t;
                        tmp.set(
                            inv*inv*fromPos.x + 2*inv*t*ctrl.x + t*t*targetPos.x,
                            inv*inv*fromPos.y + 2*inv*t*ctrl.y + t*t*targetPos.y,
                            inv*inv*fromPos.z + 2*inv*t*ctrl.z + t*t*targetPos.z,
                        );
                        node.setPosition(tmp);
                    },
                })
                .call(() => {
                    if (!node?.isValid) return;
                    node.setPosition(targetPos);
                    if (item.type === QueueItemType.Bobbin && item.bobbin) {
                        item.bobbin.updateOriginPos();
                    }
                    if (this._shiftTweens.get(item) === tw) this._shiftTweens.delete(item);
                })
                .start();
            this._shiftTweens.set(item, tw);
        }
    }

    private _hasLockBefore(row: QueueItem[], idx: number): boolean {
        for (let i = 0; i < idx; i++) {
            if (row[i].type === QueueItemType.Lock) return true;
        }
        return false;
    }

    private _cleanRow(rowIdx: number) {
        const row = this._rowQueues[rowIdx];
        for (let i = row.length - 1; i >= 0; i--) {
            const node = row[i].node;
            if (!node?.isValid) row.splice(i, 1);
        }
    }
}
