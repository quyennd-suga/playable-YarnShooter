import { _decorator, Component } from 'cc';
import { Yarn } from '../Yarn';

const { ccclass, property } = _decorator;

@ccclass('GameManager')
export class GameManager extends Component {
    public static instance: GameManager = null;

    // Lưu trữ toàn bộ Yarn trên lưới để bắn
    private allYarns: Yarn[] = [];
    /** Index yarn theo pixel (x,y) — dùng cho Yarn.shakeNeighbors lookup O(1).
     *  Yarn nào có data.x hoặc data.y < 0 (vd. Creator-spawned transient yarn) sẽ KHÔNG vào map. */
    private _yarnByPixel: Map<string, Yarn> = new Map();

    onLoad() {
        if (!GameManager.instance) {
            GameManager.instance = this;
        } else {
            this.node.destroy();
            return;
        }
    }

    private _pixelKey(x: number, y: number): string { return `${x},${y}`; }

    public registerYarn(yarn: Yarn) {
        this.allYarns.push(yarn);
        if (yarn.data && yarn.data.x >= 0 && yarn.data.y >= 0) {
            this._yarnByPixel.set(this._pixelKey(yarn.data.x, yarn.data.y), yarn);
        }
    }

    public removeYarn(yarn: Yarn) {
        const idx = this.allYarns.indexOf(yarn);
        if (idx !== -1) this.allYarns.splice(idx, 1);
        if (yarn.data && yarn.data.x >= 0 && yarn.data.y >= 0) {
            const key = this._pixelKey(yarn.data.x, yarn.data.y);
            // Chỉ delete nếu map entry thực sự là yarn này (tránh xóa nhầm yarn khác cùng key).
            if (this._yarnByPixel.get(key) === yarn) this._yarnByPixel.delete(key);
        }
    }

    /** Lookup yarn tại pixel (x, y). Trả null nếu không có. Dùng cho shakeNeighbors grid-based. */
    public getYarnAt(x: number, y: number): Yarn | null {
        return this._yarnByPixel.get(this._pixelKey(x, y)) ?? null;
    }

    /** Read-only access (legacy — vẫn dùng được). */
    public get yarns(): readonly Yarn[] { return this.allYarns; }
}
