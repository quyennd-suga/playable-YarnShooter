import { _decorator, Component, Vec3, Quat } from 'cc';
const { ccclass } = _decorator;

/**
 * Port 1:1 từ Unity SnakeItem (sub-component).
 *
 * Marker component đặt trên các collider trigger rải theo từng pixel body+tail của Snake.
 * Bobbin raycast trúng SnakeItem → `getComponentInParent(Snake)` → process hit.
 * Khi Head di chuyển qua → SnakeItem tự return về pool (Unity: OnTriggerExit).
 *
 * Cocos KHÔNG có OnTriggerExit dễ dùng — pool quản lý qua SnakeRetract trực tiếp khi tick.
 */
@ccclass('SnakeItem')
export class SnakeItem extends Component {
    public resetForPool(): void {
        this.node.setPosition(Vec3.ZERO);
        this.node.setRotation(Quat.IDENTITY);
        this.node.setScale(Vec3.ONE);
    }
}
