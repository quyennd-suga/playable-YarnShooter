import { _decorator, Component, Node, Vec3, Quat } from 'cc';
const { ccclass, property } = _decorator;

/**
 * Port 1:1 từ Tray.cs của Unity Pixel Flow.
 * Đây là "chiếc xe gòn" chở Bobbin trên băng chuyền.
 * Chứa các điểm neo (positionBobbin, Tires) và animation helpers.
 */
@ccclass('Tray')
export class Tray extends Component {

    /** Node con chứa animation nốt nhảy (port từ BoardNodMotion) */
    @property(Node) public boardNodMotion: Node = null;

    /** Điểm Bobbin được đặt lên khi lên xe */
    @property(Node) public positionBobbin: Node = null;

    /** Điểm spawn hiệu ứng khi xe đáp xuống băng chuyền */
    @property(Node) public positionFx: Node = null;

    /** Node bánh xe – ẩn khi bay, hiện khi đang chạy trên belt */
    @property(Node) public Tires: Node = null;

    // ─── Public API (mirror Tray.cs) ─────────────────────────────────────────

    /** Spawn hiệu ứng đáp và (25% chance) hiện bánh xe */
    public spawnArrivalFx() {
        // TODO: gọi MapObjectSpawner.instance.spawnFxTray(positionFx.worldPosition)
        if (this.Tires && Math.random() < 1 / 4) {
            this.Tires.active = true;
        }
    }

    /** Gọi khi trả về pool */
    public resetForPool() {
        if (this.Tires) this.Tires.active = false;
        this.resetAnim();
    }

    /** Reset animation về trạng thái nghỉ (mirror Tray.cs ResetAnim) */
    public resetAnim() {
        if (!this.boardNodMotion) return;
        this.boardNodMotion.setPosition(new Vec3(0, 0.075, 0));
    }
}
