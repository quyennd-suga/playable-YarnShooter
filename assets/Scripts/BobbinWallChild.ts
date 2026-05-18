import { _decorator, Component, Node, MeshRenderer, Vec3, Quat } from 'cc';
const { ccclass, property } = _decorator;

/**
 * Port 1:1 từ Unity BobbinWallChild.cs.
 *
 * Một ô đơn (cell) trong grid BobbinWall. Mỗi cell có 4 anchor con
 * (TopLeft/TopRight/BottomLeft/BottomRight) để BobbinWall đặt border lên.
 */
@ccclass('BobbinWallChild')
export class BobbinWallChild extends Component {
    @property(MeshRenderer) public meshRenderer: MeshRenderer = null;
    @property(Node) public TopLeft: Node = null;
    @property(Node) public TopRight: Node = null;
    @property(Node) public BottomLeft: Node = null;
    @property(Node) public BottomRight: Node = null;

    /** Reset transform về mặc định trước khi trả về pool (port từ Unity ResetForPool). */
    public resetForPool(): void {
        this.node.setPosition(Vec3.ZERO);
        this.node.setRotation(Quat.IDENTITY);
        this.node.setScale(Vec3.ONE);
    }
}
