import { _decorator, Component, Vec3, Quat } from 'cc';
const { ccclass } = _decorator;

/**
 * Port 1:1 từ Unity BobbinWallBorder.cs.
 *
 * Thanh viền của BobbinWall: 2 loại prefab khác nhau (goc cho góc, canh cho cạnh).
 * Component chỉ chịu trách nhiệm reset transform khi về pool.
 */
@ccclass('BobbinWallBorder')
export class BobbinWallBorder extends Component {
    public resetForPool(): void {
        this.node.setPosition(Vec3.ZERO);
        this.node.setRotation(Quat.IDENTITY);
        this.node.setScale(Vec3.ONE);
    }
}
