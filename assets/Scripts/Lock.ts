import { _decorator, Component, Vec3, Quat } from 'cc';
const { ccclass } = _decorator;

/**
 * Port 1:1 từ Unity Lock.cs.
 *
 * Lock đứng trong grid queue thay vị trí một Bobbin. Khi Lock ở đầu hàng:
 *   - Chặn bobbin phía sau không được click.
 *   - Chặn cluster Connection checkout (qua LevelManager.isBobbinEffectivelyActive).
 * Mở khóa bằng Key (raycast trúng Key trên belt → fly đến Lock → UnlockRow).
 */
@ccclass('Lock')
export class Lock extends Component {
    /** True khi đã có Key đang bay tới — ngăn key khác nhắm cùng lock này. */
    public isReserved: boolean = false;

    public reserve(): void { this.isReserved = true; }

    public resetForPool(): void {
        this.isReserved = false;
        this.node.setPosition(Vec3.ZERO);
        this.node.setRotation(Quat.IDENTITY);
        this.node.setScale(Vec3.ONE);
    }
}
