import { _decorator, Component, input, Input, EventTouch, PhysicsSystem, Camera, geometry } from 'cc';
import { Bobbin } from '../Bobbin';

const { ccclass, property } = _decorator;

@ccclass('InputManager')
export class InputManager extends Component {
    @property(Camera) public mainCamera: Camera = null;

    private _ray: geometry.Ray = new geometry.Ray();

    onLoad() {
        input.on(Input.EventType.TOUCH_END, this.onTouchEnd, this);
    }

    onDestroy() {
        input.off(Input.EventType.TOUCH_END, this.onTouchEnd, this);
    }

    private onTouchEnd(event: EventTouch) {
        if (!this.mainCamera) return;

        // Bắn tia (Raycast) từ vị trí chạm trên màn hình xuyên qua Camera 3D
        this.mainCamera.screenPointToRay(event.getLocationX(), event.getLocationY(), this._ray);
        
        // Kiểm tra va chạm với các vật thể vật lý 3D
        if (PhysicsSystem.instance.raycast(this._ray)) {
            const results = PhysicsSystem.instance.raycastResults;
            
            if (results.length > 0) {
                // Sắp xếp các vật thể bị chạm theo khoảng cách từ Camera
                results.sort((a, b) => a.distance - b.distance);
                const hitNode = results[0].collider.node;
                
                // Xem cái Node bị chạm vào có phải là Bobbin không
                const bobbin = hitNode.getComponent(Bobbin);
                if (bobbin) {
                    bobbin.onClick();
                }
            }
        }
    }
}
