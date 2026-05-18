import { _decorator, Component, Node, Vec3, MeshRenderer, Color, Quat } from 'cc';
const { ccclass, property } = _decorator;

/**
 * Port 1:1 từ Unity Rope.cs (dùng cho Connection cylinder nối 2 bobbin).
 *
 * Mỗi frame: đặt cylinder ở giữa pointA/pointB, xoay theo hướng nối,
 * scale Y theo nửa chiều dài (cylinder cao 2 đơn vị mặc định).
 *
 * SetColors gán 2 màu cho shader stripe (colorA = nửa gần pointA, colorB = nửa gần pointB).
 */
@ccclass('ConnectionChild')
export class ConnectionChild extends Component {
    /** Anchor node phía A (thường là bobbin.center). */
    public pointA: Node = null;
    /** Anchor node phía B. */
    public pointB: Node = null;
    /** Cylinder mesh con — sẽ được di chuyển/scale theo pointA/pointB. */
    @property(Node) public rope: Node = null;
    /** MeshRenderer của cylinder để set màu. */
    @property(MeshRenderer) public meshRenderer: MeshRenderer = null;

    private static readonly _UP: Vec3 = new Vec3(0, 1, 0);
    private _tmpDir: Vec3 = new Vec3();
    private _tmpMid: Vec3 = new Vec3();
    private _tmpRot: Quat = new Quat();

    /** Đặt màu 2 nửa cylinder theo màu 2 bobbin liên kết. */
    public setColors(colorA: Color, colorB: Color): void {
        if (!this.meshRenderer) return;
        const mat = this.meshRenderer.getMaterialInstance(0);
        if (!mat) return;
        mat.setProperty('colorA', colorA);
        mat.setProperty('colorB', colorB);
    }

    /** Reset trước khi đưa về pool. */
    public resetForPool(): void {
        this.pointA = null;
        this.pointB = null;
    }

    update(_dt: number): void {
        if (!this.pointA || !this.pointB || !this.rope) return;

        const posA = this.pointA.worldPosition;
        const posB = this.pointB.worldPosition;

        Vec3.subtract(this._tmpDir, posB, posA);
        const len = this._tmpDir.length();
        if (len < 1e-5) return;

        // Đặt vị trí cylinder ở giữa A-B
        Vec3.add(this._tmpMid, posA, posB);
        Vec3.multiplyScalar(this._tmpMid, this._tmpMid, 0.5);
        this.rope.setWorldPosition(this._tmpMid);

        // Xoay cylinder để trục up của nó hướng theo dir (giống Unity rope.up = dir.normalized)
        const norm = new Vec3();
        Vec3.multiplyScalar(norm, this._tmpDir, 1 / len);
        Quat.rotationTo(this._tmpRot, ConnectionChild._UP, norm);
        this.rope.setWorldRotation(this._tmpRot);

        // Scale Y theo nửa chiều dài (cylinder Cocos cao 2 đơn vị mặc định → scale.y = len/2)
        const sc = this.rope.scale;
        this.rope.setScale(new Vec3(sc.x, len / 2, sc.z));
    }
}
