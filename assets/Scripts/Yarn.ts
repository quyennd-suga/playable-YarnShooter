import { _decorator, Component, Node, Vec3, Color, Collider, Material, MeshRenderer, tween, Tween } from 'cc';

const { ccclass, property } = _decorator;

export interface PixelData {
    x: number;
    y: number;
    material: number;
}

@ccclass('Yarn')
export class Yarn extends Component {

    /**
     * Fired khi yarn bị despawn — (material, worldPosition).
     * Handler trả về true = đã nhận, các handler sau sẽ bị bỏ qua.
     */
    static onDespawned: Array<(material: number, worldPos: Vec3) => boolean> = [];

    public data: PixelData = null;

    public despawnDuration:  number = 0.2;
    public despawnOvershoot: number = 3;

    @property private shakeRadius:    number = 1.5;
    @property private shakeDuration:  number = 0.3;
    @property private shakeMagnitude: number = 0.08;

    @property(MeshRenderer) public meshRenderer: MeshRenderer = null;
    @property(Node)         public main:         Node         = null;
    @property(Node)         public hidden:       Node         = null;

    private _col:        Collider      = null;
    private _mat:        Material      = null;
    private _shakeTween: Tween<object> = null;

    // pre-allocated — tránh GC trong hot path
    private _shakeOrigin:   Vec3   = new Vec3();
    private _startScale:    Vec3   = new Vec3();
    private _tmpPos:        Vec3   = new Vec3();
    private _arcP1:         Vec3   = new Vec3();
    private _arcP2:         Vec3   = new Vec3();
    private _arcControl:    Vec3   = new Vec3();
    private _despawnTarget         = { t: 0 };
    private _shakeTarget           = { t: 0 };
    private _arcTarget             = { t: 0 };

    onLoad() {
        this._col = this.getComponent(Collider);
        this._mat = this.meshRenderer.getMaterialInstance(0);
    }

    public resetForPool(): void {
        if (this._shakeTween) {
            this._shakeTween.stop();
            this._shakeTween = null;
        }
        this.node.setScale(1, 1, 1);
        this.node.setPosition(0, 0, 0);
        if (this._col) this._col.enabled = true;
        this.main.active   = true;
        this.hidden.active = false;
    }

    public despawn(onComplete: () => void): void {
        if (this._shakeTween) {
            this._shakeTween.stop();
            this._shakeTween = null;
            this.node.setPosition(this._shakeOrigin);
        }
        if (this._col) this._col.enabled = false;
        this.shakeNeighbors();
        this.runDespawnRoutine(onComplete);
    }

    private runDespawnRoutine(onComplete: () => void): void {
        this._startScale.set(this.node.scale);
        this._despawnTarget.t = 0;
        // TODO: set sub-material via DataManager equivalent
        // this.meshRenderer.setMaterial(DataManager.instance.getColorMaterialSub(this.data.material), 0);

        tween(this._despawnTarget)
            .to(this.despawnDuration, { t: 1 }, {
                onUpdate: () => {
                    const s = Math.max(0, 1 - this.easeInBack(this._despawnTarget.t));
                    this.node.setScale(
                        this._startScale.x * s,
                        this._startScale.y * s,
                        this._startScale.z * s
                    );
                }
            })
            .call(() => {
                this.node.setScale(0, 0, 0);
                if (this._col) this._col.enabled = true;
                this.node.getWorldPosition(this._tmpPos);
                const handlers = Yarn.onDespawned;
                for (let i = 0; i < handlers.length; i++) {
                    if (handlers[i](this.data.material, this._tmpPos)) break;
                }
                onComplete?.();
            })
            .start();
    }

    private shakeNeighbors(): void {
        // TODO: nhân radius với scale của mapGenerator khi LevelManager sẵn sàng
        // const scale = LevelManager.instance.mapGenerator.aboveParent.worldScale.x;
    }

    public shake(): void {
        if (this._shakeTween) return;
        this.hidden.active = false;
        this.main.active   = true;
        this._shakeOrigin.set(this.node.position);
        this._shakeTarget.t = 0;

        const angle = Math.random() * Math.PI * 2;
        const dirX  = Math.cos(angle);
        const dirZ  = Math.sin(angle);

        this._shakeTween = tween(this._shakeTarget)
            .to(this.shakeDuration, { t: 1 }, {
                onUpdate: () => {
                    const offset = Math.sin(this._shakeTarget.t * Math.PI * 6)
                                 * this.shakeMagnitude
                                 * (1 - this._shakeTarget.t);
                    this.node.setPosition(
                        this._shakeOrigin.x + dirX * offset,
                        this._shakeOrigin.y,
                        this._shakeOrigin.z + dirZ * offset
                    );
                }
            })
            .call(() => {
                this.node.setPosition(this._shakeOrigin);
                this._shakeTween = null;
            })
            .start();
    }

    public setColor(color: Color): void {
        this._mat?.setProperty('albedoColor', color);
        //this._mat?.setProperty('albedo', color);
    }

    public setHidden(): void {
        this.main.active   = false;
        this.hidden.active = true;
    }

    public flyArc(fromWorld: Vec3, toWorld: Vec3, duration: number, arcHeight: number): void {
        if (this._col) this._col.enabled = false;
        this._arcTarget.t = 0;
        this._arcControl.set(
            (fromWorld.x + toWorld.x) * 0.5,
            (fromWorld.y + toWorld.y) * 0.5 + arcHeight,
            (fromWorld.z + toWorld.z) * 0.5
        );

        tween(this._arcTarget)
            .to(duration, { t: 1 }, {
                onUpdate: () => {
                    const t = this._arcTarget.t;
                    Vec3.lerp(this._arcP1,  fromWorld,    this._arcControl, t);
                    Vec3.lerp(this._arcP2,  this._arcControl, toWorld,      t);
                    Vec3.lerp(this._tmpPos, this._arcP1,  this._arcP2,      t);
                    this.node.setWorldPosition(this._tmpPos);
                }
            })
            .call(() => {
                this.node.setWorldPosition(toWorld);
                if (this._col) this._col.enabled = true;
            })
            .start();
    }

    private easeInBack(t: number): number {
        const c3 = this.despawnOvershoot + 1;
        return c3 * t * t * t - this.despawnOvershoot * t * t;
    }
}
