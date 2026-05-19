import { _decorator, Component, Quat, Vec3 } from 'cc';
const { ccclass, property } = _decorator;

/**
 * Port từ Unity RotateZ.cs — adapted cho Cocos: xoay quanh trục Y (Unity gốc xoay Z).
 * Lý do: trục trong Cocos khác Unity, mesh BarrierTail sau khi import xoay quanh Y mới đúng.
 *
 * Giữ nguyên rotation X/Z gốc của prefab, chỉ tăng dần Y theo `speed` (độ/giây).
 * Dùng cho BarrierTail rung khi barrier đang nhận damage.
 */
@ccclass('RotateY')
export class RotateY extends Component {
    @property public speed: number = 90;

    private _currentY: number = 0;
    private _initialX: number = 0;
    private _initialZ: number = 0;
    private _tmpQ: Quat = new Quat();
    private _tmpEuler: Vec3 = new Vec3();

    start() {
        // Snapshot LOCAL euler từ rotation quaternion (Cocos `node.eulerAngles` trả WORLD).
        // Giữ X/Z gốc của prefab — chỉ Y mới được spin.
        Quat.toEuler(this._tmpEuler, this.node.rotation);
        this._initialX = this._tmpEuler.x;
        this._currentY = this._tmpEuler.y;
        this._initialZ = this._tmpEuler.z;
    }

    update(dt: number) {
        this._currentY += this.speed * dt;
        Quat.fromEuler(this._tmpQ, this._initialX, this._currentY, this._initialZ);
        this.node.setRotation(this._tmpQ);
    }
}
