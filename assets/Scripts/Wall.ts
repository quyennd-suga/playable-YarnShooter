import { _decorator, Component, Node, Vec3, Quat, tween, Tween } from 'cc';
const { ccclass, property } = _decorator;

/**
 * Port 1:1 từ Unity Wall.cs.
 *
 * Chướng ngại vật TĨNH thuần visual trên above layer. KHÔNG có HP, material, hay interaction
 * với bobbin/yarn (raycast bobbin không có Wall layer trong combinedHitLayer).
 * Chỉ là decor/visual obstacle.
 */
@ccclass('Wall')
export class Wall extends Component {
    /** Visual mesh node — sẽ scale animation khi spawn. */
    @property(Node) public main: Node = null;

    /** Port Unity Wall.PlaySpawnAnimation: DOScale 0 → 1 với delay.
     *  Unity hiện comment out gọi method này trong SpawnWalls — port theo Unity (không call). */
    public playSpawnAnimation(delay: number, _duration: number, _elasticDecay: number, _elasticPeriod: number): void {
        if (!this.main) return;
        this.main.setScale(Vec3.ZERO);
        this.scheduleOnce(() => {
            if (!this.main?.isValid) return;
            tween(this.main)
                .to(0.35, { scale: new Vec3(1, 1, 1) })
                .call(() => {
                    if (this.main?.isValid) this.main.setScale(1, 1, 1);
                })
                .start();
        }, delay);
    }

    public resetForPool(): void {
        Tween.stopAllByTarget(this.node);
        if (this.main) Tween.stopAllByTarget(this.main);
        this.unscheduleAllCallbacks();
        this.node.setPosition(0, 0, 0);
        this.node.setRotation(Quat.IDENTITY);
        this.node.setScale(1, 1, 1);
        if (this.main) this.main.setScale(1, 1, 1);
    }
}
