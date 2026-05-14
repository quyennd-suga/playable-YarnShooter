import { _decorator, Component } from 'cc';
import { Yarn } from '../Yarn';

const { ccclass, property } = _decorator;

@ccclass('GameManager')
export class GameManager extends Component {
    public static instance: GameManager = null;

    // Lưu trữ toàn bộ Yarn trên lưới để bắn
    private allYarns: Yarn[] = [];

    onLoad() {
        if (!GameManager.instance) {
            GameManager.instance = this;
        } else {
            this.node.destroy();
            return;
        }
    }

    public registerYarn(yarn: Yarn) {
        this.allYarns.push(yarn);
    }

    public removeYarn(yarn: Yarn) {
        const idx = this.allYarns.indexOf(yarn);
        if (idx !== -1) {
            this.allYarns.splice(idx, 1);
        }
    }
}
