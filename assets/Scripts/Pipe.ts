import {
    _decorator, Component, Node, Vec3, Quat, Label, Color, tween, Tween,
} from 'cc';
import { Bobbin } from './Bobbin';
import { MapObjectSpawner } from './MapObjectSpawner';
import { MaterialPalette } from './MaterialPalette';
import { ShooterPipeData, ShooterData } from './Data/LevelInterfaces';
const { ccclass, property } = _decorator;

/**
 * Port 1:1 từ Unity Pipe.cs.
 *
 * Pipe đứng trong grid queue thay vị trí 1 bobbin placeholder. Khi pipe trở thành head
 * của row (bobbin ngay trước đã rời), LevelManager.handlePipeTrigger gọi spawnNextBobbin
 * → sinh bobbin mới tại vị trí pipe → bobbin animation arc đến gapPos (vị trí bobbin cũ).
 * Pipe stay tại vị trí cũ. Khi queue Pipe rỗng → shrink + release pool.
 */
@ccclass('Pipe')
export class Pipe extends Component {
    /** Label hiển thị số bobbin còn lại trong queue (= Queue.shooters.length - _shooterIndex). */
    @property(Label) public textShooterIndex: Label = null;

    @property public shrinkDuration: number = 0.2;

    public data: ShooterPipeData = null;
    private _shooterIndex: number = 0;

    /** True nếu còn shooter trong queue chưa sinh. */
    public hasMoreBobbin(): boolean {
        return !!this.data
            && !!this.data.Queue?.shooters
            && this._shooterIndex < this.data.Queue.shooters.length;
    }

    public updateText(): void {
        if (!this.textShooterIndex) return;
        if (!this.data || !this.data.Queue?.shooters) {
            this.textShooterIndex.string = '0';
        } else {
            const remaining = this.data.Queue.shooters.length - this._shooterIndex;
            this.textShooterIndex.string = remaining.toString();
        }
    }

    /** Sinh bobbin tiếp theo từ Queue tại worldPos (= pipe's worldPosition).
     *  Caller (LevelManager.handlePipeTrigger) sẽ tự move bobbin tới gapPos sau qua animation. */
    public spawnNextBobbin(parent: Node, worldPos: Vec3): Bobbin | null {
        if (!this.hasMoreBobbin()) return null;

        const shooterData: ShooterData = this.data.Queue.shooters[this._shooterIndex];
        this._shooterIndex++;
        this.updateText();

        const bobbinNode = MapObjectSpawner.instance.getBobbin(parent);
        if (!bobbinNode) return null;
        const bobbin = bobbinNode.getComponent(Bobbin);
        if (!bobbin) return null;

        bobbinNode.setWorldPosition(worldPos);
        bobbinNode.setRotation(Quat.IDENTITY);
        bobbinNode.setScale(1, 1, 1);

        bobbin.data = shooterData;
        bobbin.setScore(shooterData.ammo);
        const color = MaterialPalette.getMaterialById(shooterData.material).color;
        bobbin.setColor(color);

        return bobbin;
    }

    /** Scale pipe về 0 rồi gọi onComplete (caller release về pool).
     *  Items phía sau vẫn có thể shift song song trong lúc pipe đang thu nhỏ. */
    public shrinkAndRelease(onComplete: () => void): void {
        Tween.stopAllByTarget(this.node);
        tween(this.node)
            .to(this.shrinkDuration, { scale: Vec3.ZERO }, { easing: 'smooth' })
            .call(() => {
                if (this.node?.isValid) this.node.setScale(Vec3.ZERO);
                onComplete?.();
            })
            .start();
    }

    /** SuperBobbin: xóa shooter chưa consumed có material match.
     *  Trả về true nếu pipe không còn bobbin nào để sinh (caller có thể release ngay). */
    public purgeMaterial(material: number): boolean {
        if (!this.data?.Queue?.shooters) return true;
        for (let i = this.data.Queue.shooters.length - 1; i >= this._shooterIndex; i--) {
            if (this.data.Queue.shooters[i].material === material) {
                this.data.Queue.shooters.splice(i, 1);
            }
        }
        this.updateText();
        return !this.hasMoreBobbin();
    }

    public resetForPool(): void {
        Tween.stopAllByTarget(this.node);
        this.unscheduleAllCallbacks();
        this.node.setPosition(Vec3.ZERO);
        this.node.setRotation(Quat.IDENTITY);
        this.node.setScale(1, 1, 1);
        this.data = null;
        this._shooterIndex = 0;
    }
}
