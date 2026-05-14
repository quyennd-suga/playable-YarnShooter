import { _decorator, Component, Node, Vec3, Quat, Prefab, instantiate, tween } from 'cc';
import { Tray } from '../Tray';
import { JumpPad } from '../JumpPad';
import { SplineManager } from './SplineManager';

const { ccclass, property } = _decorator;

/**
 * Port 1:1 từ TrayManager.cs của Unity Pixel Flow.
 *
 * Vai trò: Bãi đỗ xe và điều phối "xe gòn" (Tray) bay ra/vào băng chuyền.
 *
 * Vòng đời Tray:
 *   1. Khởi tạo (resetForNewLevel): Tạo N tray từ prefab, xếp vào các slot đỗ.
 *   2. TryCheckout: Lấy xe đầu hàng → bay vòng cung (FlyToStart) đến belt → callback onArrived.
 *   3. ReturnTray:  Xe rỗng bay vòng cung (FlyBackToSlot) về slot cuối → tái dồn hàng.
 *   4. SpawnExtraTray / TrimToCount: Thêm/bớt xe khi maxTrays thay đổi.
 */
@ccclass('TrayManager')
export class TrayManager extends Component {

    public static instance: TrayManager = null;

    // ─── Inspector Fields (mirror TrayManager.cs) ────────────────────────────

    /** Node cha để neo xe (tương đương `center` trong Unity) */
    @property(Node) public center: Node = null;

    /** Các vị trí slot đỗ, từ trái → phải (tương đương positionTrayList) */
    @property([Node]) public positionTrayList: Node[] = [];

    /** Prefab xe gòn */
    @property(Prefab) public trayPrefab: Prefab = null;

    /** Tấm JumpPad – Bounce khi xe trở về bằng isBounce=true */
    @property(JumpPad) public jumpPad: JumpPad = null;

    @property public arcHeight: number = 2.0;
    @property public arcDuration: number = 0.5;
    @property public shiftDuration: number = 0.25;

    /** Khoảng cách thò ra của khay (Center) khi bắt đầu level. */
    @property public slideOffset: number = 0.25;
    /** Thời gian trượt vào của khay. */
    @property public slideDuration: number = 0.6;

    // ─── Private State ────────────────────────────────────────────────────────

    /** Trays đang rảnh, theo thứ tự từ trái → phải */
    private _availableTrays: Tray[] = [];

    /** Coroutine Shift đang chạy cho từng Tray (dùng symbol Map để huỷ khi cần) */
    private _shiftTweens: Map<Tray, any> = new Map();

    private _returningCount: number = 0;  // số tray đang bay về (chưa đến nơi)
    private _totalTrayCount: number = 0;  // available + returning + on belt

    // ─── Computed Props ───────────────────────────────────────────────────────

    public get trayCount(): number { return this.positionTrayList.length; }
    public get hasAvailableTray(): boolean { return this._availableTrays.length > 0; }
    public get availableTrayCount(): number { return this._availableTrays.length; }

    private get trayParent(): Node { return this.center ?? this.node; }

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    onLoad() {
        if (TrayManager.instance && TrayManager.instance !== this) {
            this.node.destroy();
            return;
        }
        TrayManager.instance = this;
    }

    // ─── Public API ───────────────────────────────────────────────────────────

    /**
     * Gọi trước khi load map mới: dừng tất cả tween, reset state,
     * rồi re-init tray từ prefab (tương đương ResetForNewLevel trong Unity).
     */
    public resetForNewLevel() {
        // Huỷ tất cả shift tween
        this._shiftTweens.forEach((tw) => { if (tw) tween(tw).stop(); });
        this._shiftTweens.clear();

        // Destroy tray cũ còn sót lại trong available list
        for (let t of this._availableTrays) {
            if (t && t.node && t.node.isValid) t.node.destroy();
        }

        this._availableTrays = [];
        this._returningCount = 0;
        this._totalTrayCount = 0;

        const maxTrays = SplineManager.instance ? SplineManager.instance.maxTrays : this.positionTrayList.length;
        for (let i = 0; i < maxTrays; i++) {
            const slotIndex = Math.min(i, this.positionTrayList.length - 1);
            const tray = this._spawnTray(slotIndex);
            this._availableTrays.push(tray);
            this._totalTrayCount++;
        }

        // Logic "thò thụt" Center giống Unity:
        if (this.center) {
            // Đưa về vị trí thò ra (mặc định 0.25, 0, 0)
            this.center.setPosition(this.slideOffset, 0, 0);

            // Trượt về vị trí chuẩn (0, 0, 0)
            tween(this.center)
                .to(this.slideDuration, { position: new Vec3(0, 0, 0) }, { easing: 'cubicOut' })
                .start();
        }
    }

    /**
     * Gọi khi maxTray tăng lên 1: sinh thêm 1 tray mới ở vị trí cuối,
     * rồi dồn hàng để lấp chỗ trống nếu có (SpawnExtraTray trong Unity).
     */
    public spawnExtraTray() {
        const tray = this._spawnTray(this.positionTrayList.length - 1);
        this._availableTrays.push(tray);
        this._totalTrayCount++;
        this._repackSlots();
    }

    /**
     * Xóa tray thừa (từ cuối _availableTrays) cho đến khi _totalTrayCount == targetCount.
     * Chỉ xóa được tray đang rảnh (TrimToCount trong Unity).
     */
    public trimToCount(targetCount: number) {
        while (this._totalTrayCount > targetCount && this._availableTrays.length > 0) {
            const tray = this._availableTrays.pop();
            if (tray && tray.node && tray.node.isValid) tray.node.destroy();
            this._totalTrayCount--;
        }
        this._repackSlots();
    }

    /**
     * Lấy tray đầu tiên trong hàng, bắt nó bay về targetPos.
     * Các tray còn lại dồn sang trái. Trả về false nếu hàng rỗng.
     * (TryCheckout trong Unity)
     */
    public tryCheckout(targetPos: Vec3, onArrived: (tray: Tray) => void, targetRotation: Quat, targetScale: number = 1): boolean {
        if (this._availableTrays.length === 0) return false;

        const tray = this._availableTrays.shift();
        this._repackSlots();

        if (this._shiftTweens.has(tray)) {
            const existing = this._shiftTweens.get(tray);
            if (existing) existing.stop();
            this._shiftTweens.delete(tray);
        }

        this._flyToStart(tray, targetPos, targetRotation, onArrived, targetScale);
        return true;
    }

    /**
     * Tray từ belt trở về, bay vào slot trống ở cuối hàng.
     * Khi đến nơi sẽ repack để tránh chồng vị trí.
     * (ReturnTray trong Unity)
     */
    public returnTray(tray: Tray, isBounce: boolean) {
        if (isBounce && this.jumpPad) {
            this.jumpPad.bounce();
        }

        const targetIndex = Math.min(
            this._availableTrays.length + this._returningCount,
            this.positionTrayList.length - 1
        );

        this._returningCount++;
        this._flyBackToSlot(tray, this.positionTrayList[targetIndex], () => {
            this._returningCount--;
            this._availableTrays.push(tray);
            this._repackSlots();
        });
    }

    // ─── Private: Pool ────────────────────────────────────────────────────────

    private _spawnTray(slotIndex: number): Tray {
        const trayNode = instantiate(this.trayPrefab);
        trayNode.setParent(this.trayParent, false);
        trayNode.setPosition(this.positionTrayList[slotIndex].position);
        let initRot = new Quat();
        Quat.fromEuler(initRot, 90, -90, 0);
        trayNode.setRotation(initRot);
        trayNode.setScale(new Vec3(0.85, 0.85, 0.85));
        return trayNode.getComponent(Tray) ?? trayNode.addComponent(Tray);
    }

    // ─── Private: Repack (RepackSlots trong Unity) ────────────────────────────

    /** Dồn tất cả available trays về đúng slot; tray dư clamped về slot cuối cùng */
    private _repackSlots() {
        for (let i = 0; i < this._availableTrays.length; i++) {
            const slotIndex = Math.min(i, this.positionTrayList.length - 1);
            // Sử dụng tọa độ LOCAL của slot
            this._shiftTrayTo(this._availableTrays[i], this.positionTrayList[slotIndex].position.clone());
        }
    }

    // ─── Private: Shift (ShiftRoutine trong Unity) ────────────────────────────

    private _shiftTrayTo(tray: Tray, targetPos: Vec3) {
        if (this._shiftTweens.has(tray)) {
            const existing = this._shiftTweens.get(tray);
            if (existing) existing.stop();
        }

        const from = tray.node.position.clone(); // Lấy vị trí LOCAL hiện tại
        const tempObj = { t: 0 };
        const tempPos = new Vec3();
        const tw = tween(tempObj)
            .to(this.shiftDuration, { t: 1 }, {
                onUpdate: () => {
                    Vec3.lerp(tempPos, from, targetPos, tempObj.t);
                    tray.node.setPosition(tempPos); // Cập nhật vị trí LOCAL
                }
            })
            .call(() => {
                tray.node.setPosition(targetPos); // Đảm bảo đúng vị trí LOCAL khi kết thúc
                this._shiftTweens.delete(tray);
            })
            .start();
        this._shiftTweens.set(tray, tw);
    }

    // ─── Private: Animations (FlyToStart / FlyBackToSlot trong Unity) ─────────

    /**
     * Bay vòng cung Bezier từ slot đỗ → điểm bắt đầu belt.
     * Tires ẩn khi bay, xoay từ Euler(90,90,0) → Euler(0,-180,0), scale → targetScale.
     */
    private _flyToStart(tray: Tray, to: Vec3, rotToWorld: Quat, onArrived: (tray: Tray) => void, targetScale: number) {
        if (tray.Tires) tray.Tires.active = false;

        const from = tray.node.worldPosition.clone();
        const control = new Vec3(
            (from.x + to.x) * 0.5,
            Math.max(from.y, to.y) + this.arcHeight,
            (from.z + to.z) * 0.5
        );

        const rotFromWorld = tray.node.worldRotation.clone();
        // rotToWorld nay da duoc truyen tu SplineManager vao, khong hardcode nua

        const scaleFrom = tray.node.scale.clone();
        const scaleTo = new Vec3(targetScale, targetScale, targetScale);

        tray.node.setParent(this.node, true); // reparent ra ngoài

        const tempObj = { pct: 0 };
        const tempPos = new Vec3();
        const tempRot = new Quat();
        const tempScale = new Vec3();
        const p0 = new Vec3(), p1 = new Vec3();

        tween(tempObj)
            .to(this.arcDuration, { pct: 1 }, {
                onUpdate: () => {
                    const pct = tempObj.pct;
                    Vec3.lerp(p0, from, control, pct);
                    Vec3.lerp(p1, control, to, pct);
                    Vec3.lerp(tempPos, p0, p1, pct);
                    tray.node.setWorldPosition(tempPos);

                    Quat.slerp(tempRot, rotFromWorld, rotToWorld, pct);
                    tray.node.setWorldRotation(tempRot);

                    Vec3.lerp(tempScale, scaleFrom, scaleTo, pct);
                    tray.node.setScale(tempScale);
                }
            })
            .call(() => {
                tray.node.setWorldPosition(to);
                tray.node.setWorldRotation(rotToWorld);
                tray.node.setScale(scaleTo);
                if (onArrived) onArrived(tray);
            })
            .start();
    }
    /**
     * Bay vòng cung Bezier từ belt → slot đỗ.
     * Tires ẩn, xoay về Euler(90,90,0), scale → 0.85, gọi tray.resetAnim() khi xong.
     */
    private _flyBackToSlot(tray: Tray, slotNode: Node, onArrived: () => void) {
        if (tray.Tires) tray.Tires.active = false;

        const from = tray.node.worldPosition.clone();
        const to = slotNode.worldPosition.clone();
        // Control ngay trên đích: tray bay thẳng về cột slot rồi rơi xuống,
        // không đi qua giữa màn hình như khi dùng midpoint
        const control = new Vec3(to.x, from.y + this.arcHeight, to.z);

        tray.node.setParent(this.trayParent, true);

        const rotFrom = tray.node.rotation.clone();
        const rotTo = new Quat(); Quat.fromEuler(rotTo, 90, -90, 0);

        const scaleFrom = tray.node.scale.clone();
        const scaleTo = new Vec3(0.85, 0.85, 0.85);

        const tempObj = { pct: 0 };
        const tempPos = new Vec3();
        const tempRot = new Quat();
        const tempScale = new Vec3();
        const p0 = new Vec3(), p1 = new Vec3();

        tween(tempObj)
            .to(this.arcDuration, { pct: 1 }, {
                onUpdate: () => {
                    const pct = tempObj.pct;
                    Vec3.lerp(p0, from, control, pct);
                    Vec3.lerp(p1, control, to, pct);
                    Vec3.lerp(tempPos, p0, p1, pct);
                    tray.node.setWorldPosition(tempPos);

                    Quat.slerp(tempRot, rotFrom, rotTo, pct);
                    tray.node.setRotation(tempRot);

                    Vec3.lerp(tempScale, scaleFrom, scaleTo, pct);
                    tray.node.setScale(tempScale);
                }
            })
            .call(() => {
                // Đọc lại worldPosition tươi của slot để tránh lệch do center đang slide
                tray.node.setWorldPosition(slotNode.worldPosition);
                tray.node.setRotation(rotTo);
                tray.node.setScale(scaleTo);
                tray.resetAnim();
                if (onArrived) onArrived();
            })
            .start();
    }
}
