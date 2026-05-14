import { _decorator, Component, Vec3, tween } from 'cc';
const { ccclass, property } = _decorator;

/**
 * Port 1:1 từ Unity RopeBobbin.cs.
 * Mỗi ring (vòng dây) trên bobbin gắn 1 component này.
 * Khi node được active: scale từ (start, width, start) → (end, width, end) trong 0.1s.
 */
@ccclass('RopeBobbin')
export class RopeBobbin extends Component {
    @property public start: number = 0;
    @property public end: number = 1;
    @property public width: number = 1;

    onEnable() {
        // Set scale ban đầu rồi tween về scale cuối (giống Unity DOScale 0.1s)
        this.node.setScale(new Vec3(this.start, this.width, this.start));
        tween(this.node)
            .to(0.1, { scale: new Vec3(this.end, this.width, this.end) })
            .start();
    }
}
