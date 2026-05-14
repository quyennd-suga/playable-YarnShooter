import { _decorator, Component, Vec3, tween } from 'cc';
import { EventBus, GameEvents } from './EventBus';
import { Bobbin } from '../Bobbin';
import { SplineManager } from './SplineManager';

const { ccclass, property } = _decorator;

/**
 * Quản lý lifecycle level và grid queue bobbin.
 * Tương đương Unity LevelManager — sở hữu _rowQueues,
 * xử lý InitQueueStates, OnBobbinLeaveQueue, ShiftRow.
 */
@ccclass('LevelManager')
export class LevelManager extends Component {
    public static instance: LevelManager = null;

    @property public queueShiftDuration: number = 0.3;
    @property public queueJumpHeight: number = 0.3;
    @property public queueDipHeight: number = 0.08;
    @property public queueDipRatio: number = 0.25;

    // ─── Unified queue (giống Unity LevelManager._rowQueues) ────────────────────
    // Mỗi row là một cột bobbins. row[0] = bobbin đầu hàng (active).
    private _rowQueues: Bobbin[][] = [];
    private _rowBaseX: number[] = [];
    private _rowBaseZ: number[] = [];
    private _rowSpacing: number = 0.15;

    onLoad() {
        if (!LevelManager.instance) { LevelManager.instance = this; }
        else { this.node.destroy(); return; }
        EventBus.on(GameEvents.ON_BOBBIN_CLICKED, this._onBobbinClicked, this);
    }

    // ─── Setup (gọi từ MapGenerator khi spawn bobbin) ────────────────────────────

    /// Khởi tạo cấu trúc hàng chờ. Gọi trước addBobbinToRow.
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

    /// Thêm bobbin vào row; ghi nhận base position để dùng cho ShiftRow.
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
        row.push(bobbin);
    }

    /// Đặt trạng thái active/inactive sau khi spawn xong. Giống Unity InitQueueStates.
    public initQueueStates() {
        for (let r = 0; r < this._rowQueues.length; r++) {
            this._cleanRow(r);
            const row = this._rowQueues[r];
            for (let i = 0; i < row.length; i++) {
                row[i].setActiveState(i === 0);
            }
        }
    }

    // ─── Queue departure (giống Unity OnBobbinLeaveQueue) ───────────────────────

    /// Gọi khi bobbin rời hàng (bị rút bởi booster hoặc logic khác, không qua click).
    public onBobbinLeave(bobbin: Bobbin) {
        for (let r = 0; r < this._rowQueues.length; r++) {
            const idx = this._rowQueues[r].indexOf(bobbin);
            if (idx === -1) continue;
            this._rowQueues[r].splice(idx, 1);
            bobbin.inQueueRow = false;
            this._shiftRow(r);
            return;
        }
    }

    // ─── Private ─────────────────────────────────────────────────────────────────

    private _onBobbinClicked(bobbin: Bobbin) {
        if (!bobbin.inQueueRow) return;
        if (!bobbin.isActive) { bobbin.shake(); return; }
        if (!SplineManager.instance?.hasAvailableSlot()) { bobbin.shake(); return; }

        for (let r = 0; r < this._rowQueues.length; r++) {
            const idx = this._rowQueues[r].indexOf(bobbin);
            if (idx === -1) continue;
            this._rowQueues[r].splice(idx, 1);
            bobbin.inQueueRow = false;
            bobbin.setActiveState(false);
            this._shiftRow(r);
            break;
        }

        EventBus.emit(GameEvents.ON_BOBBIN_CHECKOUT, bobbin);
    }

    /// Dồn tất cả bobbin trong row về đúng slot. Giống Unity ShiftRow.
    private _shiftRow(rowIdx: number) {
        const row = this._rowQueues[rowIdx];
        const baseX = this._rowBaseX[rowIdx];
        const baseZ = this._rowBaseZ[rowIdx];

        for (let i = 0; i < row.length; i++) {
            const bobbin = row[i];
            if (!bobbin?.node?.isValid) continue;

            const targetPos = new Vec3(baseX, 0, baseZ + i * this._rowSpacing);
            bobbin.setActiveState(i === 0);

            const fromPos = bobbin.node.position.clone();
            const isHead = i === 0;
            // Head bobbin nhún nhẹ giống Unity (dip rồi jump)
            const ctrlY = isHead
                ? Math.max(fromPos.y, targetPos.y) + this.queueJumpHeight
                : (fromPos.y + targetPos.y) * 0.5;
            const ctrl = new Vec3(
                (fromPos.x + targetPos.x) * 0.5,
                ctrlY,
                (fromPos.z + targetPos.z) * 0.5
            );
            const temp = { r: 0 };
            const tmp = new Vec3();
            tween(temp)
                .to(this.queueShiftDuration, { r: 1 }, {
                    onUpdate: () => {
                        if (!bobbin.node?.isValid) return;
                        const t = temp.r, inv = 1 - t;
                        tmp.set(
                            inv*inv*fromPos.x + 2*inv*t*ctrl.x + t*t*targetPos.x,
                            inv*inv*fromPos.y + 2*inv*t*ctrl.y + t*t*targetPos.y,
                            inv*inv*fromPos.z + 2*inv*t*ctrl.z + t*t*targetPos.z
                        );
                        bobbin.node.setPosition(tmp);
                    }
                })
                .call(() => {
                    if (!bobbin.node?.isValid) return;
                    bobbin.node.setPosition(targetPos);
                    bobbin.updateOriginPos();
                })
                .start();
        }
    }

    private _cleanRow(rowIdx: number) {
        const row = this._rowQueues[rowIdx];
        for (let i = row.length - 1; i >= 0; i--) {
            if (!row[i]?.node?.isValid) row.splice(i, 1);
        }
    }
}
