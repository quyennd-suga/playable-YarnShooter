import { _decorator, Component, Vec3 } from 'cc';
const { ccclass, property } = _decorator;

/**
 * Port 1:1 từ JumpPad.cs của Unity Pixel Flow.
 * Hiệu ứng "nảy" của tấm đệm khi xe Tray trở về.
 * 3 pha: Nén → Bật → Về ban đầu.
 */
@ccclass('JumpPad')
export class JumpPad extends Component {

    @property public compressDuration: number = 0.08;
    @property public springDuration:   number = 0.10;
    @property public settleDuration:   number = 0.18;

    @property public compressY:  number = 0.45;
    @property public compressXZ: number = 1.35;
    @property public springY:    number = 1.35;
    @property public springXZ:   number = 0.88;

    private _originalScale: Vec3 = new Vec3();
    private _routine: number = -1;

    onLoad() {
        this.node.getScale(this._originalScale);
    }

    public bounce() {
        this.unschedule(this._bounceCallback);
        this._elapsedBounce = 0;
        this._bouncePhase = 0;
        this.schedule(this._bounceCallback, 0, 999999);
    }

    // ─── Internal Bounce State Machine ───────────────────────────────────────

    private _elapsedBounce: number = 0;
    private _bouncePhase: number = 0;   // 0=compress, 1=spring, 2=settle
    private _fromScale: Vec3 = new Vec3();
    private _toScale:   Vec3 = new Vec3();

    private _bounceCallback = (dt: number) => {
        const orig = this._originalScale;

        // Xác định from/to cho từng pha
        if (this._bouncePhase === 0) {
            Vec3.copy(this._fromScale, orig);
            this._toScale.set(orig.x * this.compressXZ, orig.y * this.compressY, orig.z * this.compressXZ);
        } else if (this._bouncePhase === 1) {
            this._fromScale.set(orig.x * this.compressXZ, orig.y * this.compressY, orig.z * this.compressXZ);
            this._toScale.set(orig.x * this.springXZ, orig.y * this.springY, orig.z * this.springXZ);
        } else {
            this._fromScale.set(orig.x * this.springXZ, orig.y * this.springY, orig.z * this.springXZ);
            Vec3.copy(this._toScale, orig);
        }

        const durations = [this.compressDuration, this.springDuration, this.settleDuration];
        const duration = durations[this._bouncePhase];

        this._elapsedBounce += dt;
        const t = Math.min(this._elapsedBounce / duration, 1);
        const s = new Vec3();
        Vec3.lerp(s, this._fromScale, this._toScale, t);
        this.node.setScale(s);

        if (t >= 1) {
            this._elapsedBounce = 0;
            this._bouncePhase++;
            if (this._bouncePhase > 2) {
                this.unschedule(this._bounceCallback);
                this.node.setScale(orig);
            }
        }
    };
}
