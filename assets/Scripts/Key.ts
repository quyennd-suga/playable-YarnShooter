import { _decorator, Component, Node, Vec3, Quat, tween } from 'cc';
const { ccclass, property } = _decorator;

/**
 * Port 1:1 từ Unity Key.cs.
 *
 * Key đặt trên above layer (cùng yarns). Khi bobbin raycast trên belt trúng key:
 *   - LevelManager.tryFindHeadLock() tìm Lock đầu hàng chưa reserved.
 *   - key.tryActivate(lockWorldPos, onUnlocked):
 *     - Bay vòng cung 0.5s (Y = flyHeight * sin(π * t)).
 *     - Khi đến nơi: gọi onUnlocked → LevelManager.unlockRow(rowIdx).
 *     - Scale key visual về 0 + bật fx.
 */
@ccclass('Key')
export class Key extends Component {
    @property public flyHeight: number = 1.5;
    @property public flyDuration: number = 0.5;

    /** Node visual của key (sẽ scale về 0 khi mở khóa thành công). Port từ Unity `key` field. */
    @property(Node) public key: Node = null;
    /** Node FX particle (kích hoạt khi mở khóa). Port từ Unity `fx` field. */
    @property(Node) public fx: Node = null;

    private _isUsed: boolean = false;

    /** Kích hoạt key: bay vòng cung đến lockWorldPos rồi gọi onUnlocked.
     *  Trả về false nếu key đã được dùng rồi (port từ Unity Key.TryActivate). */
    public tryActivate(lockWorldPos: Vec3, onUnlocked: () => void): boolean {
        if (this._isUsed) return false;
        this._isUsed = true;
        this._flyToLock(lockWorldPos.clone(), onUnlocked);
        return true;
    }

    private _flyToLock(to: Vec3, onUnlocked: () => void): void {
        const from = this.node.worldPosition.clone();
        const ctx = { t: 0 };
        const tmpPos = new Vec3();

        tween(ctx)
            .to(this.flyDuration, { t: 1 }, {
                onUpdate: () => {
                    if (!this.node?.isValid) return;
                    const t = Math.max(0, Math.min(1, ctx.t));
                    const arc = this.flyHeight * Math.sin(Math.PI * t);
                    tmpPos.set(
                        from.x + (to.x - from.x) * t,
                        from.y + (to.y - from.y) * t + arc,
                        from.z + (to.z - from.z) * t,
                    );
                    this.node.setWorldPosition(tmpPos);
                }
            })
            .call(() => {
                if (!this.node?.isValid) return;
                this.node.setWorldPosition(to);
                // Port Unity: gọi callback unlock TRƯỚC khi shrink key visual + bật fx
                onUnlocked?.();
                if (this.key) this.key.setScale(0, 0, 0);
                if (this.fx) this.fx.active = true;
                // TODO: play sound SFX_CRASH_LOCK khi có SoundManager bên Cocos
            })
            .start();
    }

    /** Reset state trước khi trả về pool. Port từ Unity Key.ResetForPool. */
    public resetForPool(): void {
        this.unscheduleAllCallbacks();
        this._isUsed = false;
        if (this.key) this.key.setScale(1, 1, 1);
        if (this.fx) this.fx.active = false;
        this.node.setPosition(Vec3.ZERO);
        this.node.setRotation(Quat.IDENTITY);
        this.node.setScale(Vec3.ONE);
    }
}
