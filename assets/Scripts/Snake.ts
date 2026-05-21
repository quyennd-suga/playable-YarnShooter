import { _decorator, Component, MeshRenderer, Color, Vec3, Quat } from 'cc';
import { SnakeRetract } from './SnakeRetract';
import { MapObjectSpawner } from './MapObjectSpawner';
import { MaterialPalette } from './MaterialPalette';
import { GridPointData } from './Data/LevelInterfaces';
const { ccclass, property } = _decorator;

/**
 * Port 1:1 từ Unity Snake.cs — wrapper mỏng quanh SnakeRetract.
 *
 * Quản lý material, gridPointData (vị trí đuôi), callback onComplete → release pool.
 * Logic chính nằm trong SnakeRetract.
 */
@ccclass('Snake')
export class Snake extends Component {
    @property(SnakeRetract) public snakeRetract: SnakeRetract = null;
    @property(MeshRenderer) public meshRendererHead: MeshRenderer = null;
    @property(MeshRenderer) public meshRendererBody: MeshRenderer = null;
    @property(MeshRenderer) public meshRendererSnakeHole: MeshRenderer = null;

    /** Property name cho color skin tint trên Head/Body shader (Unity dùng _SkinTint). */
    @property public skinTintProperty: string = 'mainColor';
    /** Property name cho pattern color (Unity dùng _PatternColor). */
    @property public patternColorProperty: string = 'patternColor';
    /** Property name cho SnakeHole albedo (Unity swap bobbinmaterial → ở Cocos chỉ tint). */
    @property public holeColorProperty: string = 'albedoColor';

    public material: number = 0;
    public gridPointData: GridPointData | null = null;

    onEnable() {
        if (this.snakeRetract) {
            this.snakeRetract.onComplete = () => this._onSnakeComplete();
        }
    }

    onDisable() {
        if (this.snakeRetract) {
            this.snakeRetract.onComplete = null;
        }
    }

    private _onSnakeComplete(): void {
        MapObjectSpawner.instance?.releaseSnake(this);
    }

    /** Port từ Unity Snake.ChangeMaterial: set color cho Head/Body (skin+pattern) + SnakeHole. */
    public changeMaterial(): void {
        const mat = MaterialPalette.getMaterialById(this.material);
        const colorA = mat.color;
        // Unity: colorB = colorItemData.colorB * 0.8. Cocos MaterialData chỉ có 1 color
        // → dùng cùng colorA hoặc darken làm pattern. Tinh chỉnh shader nếu cần.
        const colorB = new Color(
            Math.round(colorA.r * 0.5),
            Math.round(colorA.g * 0.5),
            Math.round(colorA.b * 0.5),
            255,
        );

        this._applyRendererColor(this.meshRendererHead, colorA, colorB);
        this._applyRendererColor(this.meshRendererBody, colorA, colorB);
        if (this.meshRendererSnakeHole) {
            const hmat = this.meshRendererSnakeHole.getMaterialInstance(0);
            if (hmat) hmat.setProperty(this.holeColorProperty, colorA);
        }
    }

    private _applyRendererColor(mr: MeshRenderer | null, colorA: Color, colorB: Color): void {
        if (!mr) return;
        const m = mr.getMaterialInstance(0);
        if (!m) return;
        m.setProperty(this.skinTintProperty, colorA);
        m.setProperty(this.patternColorProperty, colorB);
    }

    /** SuperBobbin: release ngay snake về pool (không animation — match Unity InstantRelease). */
    public instantRelease(): void {
        MapObjectSpawner.instance?.releaseSnake(this);
    }

    public resetForPool(): void {
        if (this.snakeRetract) this.snakeRetract.resetForPool();
        this.node.setPosition(Vec3.ZERO);
        this.node.setRotation(Quat.IDENTITY);
        this.node.setScale(1, 1, 1);
        this.material = 0;
        this.gridPointData = null;
    }
}
