import { _decorator, Component, Node, MeshRenderer, Color, Vec3, Tween, tween } from 'cc';
import { RotateY } from './RotateY';
import { MapObjectSpawner } from './MapObjectSpawner';
const { ccclass, property } = _decorator;

/**
 * Port 1:1 từ Unity Barrier.cs.
 *
 * Hàng rào dài có Head + Body + Tail, đặt trên above layer.
 * Bobbin cùng material va vào → trừ HP của barrier (KHÔNG trừ ammo bobbin!).
 * Lerp body.scale.z + head.pos.z rút ngắn dần theo HP còn lại. Hết HP → shrink + pool.
 */
@ccclass('Barrier')
export class Barrier extends Component {
    @property(Node) public BarrierBody: Node = null;
    @property(Node) public BarrierHead: Node = null;
    @property(Node) public BarrierTail: Node = null;

    @property(MeshRenderer) public centerRenderer: MeshRenderer = null;
    @property(MeshRenderer) public bodyRenderer_1: MeshRenderer = null;
    @property(MeshRenderer) public bodyRenderer_2: MeshRenderer = null;

    @property(RotateY) public rotationTail: RotateY = null;

    @property public lerpDuration: number = 0.25;

    /** Index sub-material trên centerRenderer dùng cho màu chính (Unity dùng materials[1]). */
    @property public centerMaterialIndex: number = 1;

    /** Tên property của material để set màu.
     *  - bodyRenderer_1/2: dùng rope-scale-independent shader → `mainColor`.
     *  - centerRenderer: dùng standard shader → `albedoColor` (default Cocos PBR/lit). */
    @property public bodyColorProperty: string = 'mainColor';
    @property public centerColorProperty: string = 'albedoColor';

    public scale: number = 1;
    public score: number = 0;
    public material: number = 0;

    /** Constants điều chỉnh theo SetScale — port từ Unity defaults. */
    public scaleBody: number = 0.0375;
    public barrierbody: number = 0.0375;
    public barrierhead: number = 0.043;

    private _initialScore: number = 0;
    private _initialBodyScaleZ: number = 0;
    private _initialHeadPosZ: number = 0;

    private _lerpCtx: any = null;

    // ─── Setup ────────────────────────────────────────────────────────────────────

    /** Đặt scale tổng (1, 3, 4) — Unity convention dựa trên sqrt(gridPoints.Count). */
    public setScale(s: number): void {
        this.scale = s;
        if (s === 4) {
            if (this.BarrierTail) this.BarrierTail.setScale(3.5, 3.5, 3.5);
            this.scaleBody = 0.065;
            this.barrierbody = 0.065;
            if (this.BarrierHead) this.BarrierHead.setScale(1.8, 1.8, 1.8);
            this.barrierhead = 0.08;
        } else if (s === 3) {
            if (this.BarrierTail) this.BarrierTail.setScale(2.5, 2.5, 2.5);
            this.scaleBody = 0.06;
            this.barrierbody = 0.056;
            if (this.BarrierHead) this.BarrierHead.setScale(1.39, 1.39, 1.39);
            this.barrierhead = 0.066;
        } else {
            if (this.BarrierTail) this.BarrierTail.setScale(1.8, 1.8, 1.8);
            this.scaleBody = 0.0375;
            this.barrierbody = 0.0375;
            if (this.BarrierHead) this.BarrierHead.setScale(1, 1, 1);
            this.barrierhead = 0.043;
        }
    }

    /** Set độ dài thân: body.scale.z = barrierbody + 0.0375 * length. */
    public setBarrierBody(length: number): void {
        if (!this.BarrierBody) return;
        this.BarrierBody.setScale(this.scaleBody, this.scaleBody, this.barrierbody + 0.0375 * length);
    }

    /** Set vị trí đầu: head.localPos.z = -(barrierhead + 0.0755 * length). */
    public setBarrierHeadPosition(length: number): void {
        if (!this.BarrierHead) return;
        this.BarrierHead.setPosition(0, 0, -(this.barrierhead + 0.0755 * length));
    }

    /** Set màu cho center sub-material + bodyRenderers qua material instance.
     *  Cocos không có MaterialPropertyBlock — phải dùng material instance per renderer.
     *  Property name lấy từ Inspector (mặc định `mainColor` cho rope-scale-independent shader). */
    public setColor(color: Color): void {
        if (this.centerRenderer) {
            const mat = this.centerRenderer.getMaterialInstance(this.centerMaterialIndex);
            if (mat) mat.setProperty(this.centerColorProperty, color);
        }
        if (this.bodyRenderer_1) {
            const mat = this.bodyRenderer_1.getMaterialInstance(0);
            if (mat) mat.setProperty(this.bodyColorProperty, color);
        }
        if (this.bodyRenderer_2) {
            const mat = this.bodyRenderer_2.getMaterialInstance(0);
            if (mat) mat.setProperty(this.bodyColorProperty, color);
        }
    }

    /** Snapshot initial values cho lerp. Tắt rotationTail mặc định. */
    public initScoreSteps(): void {
        if (this.rotationTail) this.rotationTail.enabled = false;
        this._initialScore = this.score;
        this._initialBodyScaleZ = this.BarrierBody ? this.BarrierBody.scale.z : 0;
        this._initialHeadPosZ = this.BarrierHead ? this.BarrierHead.position.z : 0;
    }

    // ─── Damage ───────────────────────────────────────────────────────────────────

    /** Trừ 1 HP. Lerp body shrink + head dời lại. Hết HP → shrink scale toàn barrier + pool. */
    public decrementScore(): void {
        if (this.score <= 0) return;
        this.score--;
        // TODO: LevelManager.playYarnSound() khi port sound

        const ratio = this._initialScore > 0 ? this.score / this._initialScore : 0;
        const targetBodyZ = this.barrierbody + (this._initialBodyScaleZ - this.barrierbody) * ratio;
        const targetHeadZ = -this.barrierhead + (this._initialHeadPosZ + this.barrierhead) * ratio;

        this._stopLerp();
        this._startLerp(targetBodyZ, targetHeadZ);
    }

    private _startLerp(targetBodyZ: number, targetHeadZ: number): void {
        if (this.rotationTail) this.rotationTail.enabled = true;

        const fromBodyZ = this.BarrierBody ? this.BarrierBody.scale.z : 0;
        const fromHeadZ = this.BarrierHead ? this.BarrierHead.position.z : 0;

        const ctx = { t: 0 };
        this._lerpCtx = ctx;

        tween(ctx)
            .to(this.lerpDuration, { t: 1 }, {
                onUpdate: () => {
                    if (!this.node?.isValid) return;
                    const t = Math.max(0, Math.min(1, ctx.t));
                    // ease out quad: s = 1 - (1 - t)^2
                    const s = 1 - (1 - t) * (1 - t);
                    if (this.BarrierBody) {
                        this.BarrierBody.setScale(
                            this.scaleBody,
                            this.scaleBody,
                            fromBodyZ + (targetBodyZ - fromBodyZ) * s,
                        );
                    }
                    if (this.BarrierHead) {
                        this.BarrierHead.setPosition(0, 0, fromHeadZ + (targetHeadZ - fromHeadZ) * s);
                    }
                }
            })
            .call(() => {
                if (!this.node?.isValid) return;
                if (this.BarrierBody) this.BarrierBody.setScale(this.scaleBody, this.scaleBody, targetBodyZ);
                if (this.BarrierHead) this.BarrierHead.setPosition(0, 0, targetHeadZ);
                if (this._lerpCtx === ctx) this._lerpCtx = null;
                if (this.rotationTail) this.rotationTail.enabled = false;
                if (this.score <= 0) {
                    // Shrink scale toàn barrier rồi release pool — port từ Unity DOScale(0, 0.1)
                    tween(this.node)
                        .to(0.1, { scale: Vec3.ZERO })
                        .call(() => {
                            if (this.node?.isValid) MapObjectSpawner.instance.releaseBarrier(this);
                        })
                        .start();
                }
            })
            .start();
    }

    private _stopLerp(): void {
        if (this._lerpCtx) {
            Tween.stopAllByTarget(this._lerpCtx);
            this._lerpCtx = null;
        }
    }

    /** SuperBobbin: xoá ngay barrier bằng shrink animation 0.15s rồi pool.
     *  Port từ Unity Barrier.InstantRelease. */
    public instantRelease(): void {
        this._stopLerp();
        Tween.stopAllByTarget(this.node);
        this.score = 0;
        tween(this.node)
            .to(0.15, { scale: Vec3.ZERO })
            .call(() => {
                if (this.node?.isValid) MapObjectSpawner.instance.releaseBarrier(this);
            })
            .start();
    }

    // ─── Pool reset ───────────────────────────────────────────────────────────────

    public resetForPool(): void {
        this._stopLerp();
        Tween.stopAllByTarget(this.node);
        this.unscheduleAllCallbacks();
        if (this.rotationTail) this.rotationTail.enabled = false;
        this.node.setPosition(0, 0, 0);
        this.node.setRotationFromEuler(0, 0, 0);
        this.node.setScale(1, 1, 1);
        this._initialScore = 0;
        this._initialBodyScaleZ = 0;
        this._initialHeadPosZ = 0;
        this.score = 0;
        this.material = 0;
        this.scale = 1;
    }
}
