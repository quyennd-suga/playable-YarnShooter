import {
    _decorator, Component, Node, Vec3, Color, Collider, MeshRenderer,
    tween, Tween,
} from 'cc';
import { GameManager } from './Core/GameManager';

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

    /** @deprecated Không còn dùng — shakeNeighbors giờ lookup theo pixel grid (data.x/y). */
    @property private shakeRadius:    number = 1.5;
    @property private shakeDuration:  number = 0.3;
    @property private shakeMagnitude: number = 0.08;

    /** Bán kính shake tính theo CELL UNIT (pixel grid). Default 1 = chỉ shake 8-neighborhood
     *  (3x3 ô bao quanh). Tăng lên 2 = 5x5 ô. Dùng vòng tròn (dx²+dy² ≤ r²) trong cell space. */
    @property public neighborRadiusCells: number = 1;

    @property(MeshRenderer) public meshRenderer: MeshRenderer = null;
    @property(Node)         public main:         Node         = null;
    @property(Node)         public hidden:       Node         = null;

    private _col:        Collider      = null;
    private _shakeTween: Tween<object> = null;

    /** Buffer dùng chung khi push color vào instance attribute — tránh allocate mỗi setColor. */
    private static _instColorBuf: number[] = [1, 1, 1, 1];

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
        // KHÔNG gọi getMaterialInstance — sẽ tạo material instance riêng cho mỗi yarn
        // → phá GPU instancing batching. Color giờ truyền qua a_instanceColor attribute
        // (xem setColor + mk-toon-simple.effect).
    }

    /** Stop tất cả tween đang chạy trên 3 target objects khi component bị destroy.
     *  Tránh crash "Cannot read properties of null (reading 't')" do Cocos nullify field
     *  giữa lúc tween onUpdate vẫn schedule. */
    onDestroy() {
        if (this._shakeTween) {
            this._shakeTween.stop();
            this._shakeTween = null;
        }
        Tween.stopAllByTarget(this._arcTarget);
        Tween.stopAllByTarget(this._despawnTarget);
        Tween.stopAllByTarget(this._shakeTarget);
    }

    public resetForPool(): void {
        if (this._shakeTween) {
            this._shakeTween.stop();
            this._shakeTween = null;
        }
        // Stop tween FlyArc + Despawn nếu đang chạy — tránh tween cũ ghi position trên
        // node ẩn (sau pool.put) hoặc trên node tái dùng (sau pool.get).
        Tween.stopAllByTarget(this._arcTarget);
        Tween.stopAllByTarget(this._despawnTarget);
        this.node.setScale(1, 1, 1);
        this.node.setPosition(0, 0, 0);
        if (this._col) this._col.enabled = true;
        if (this.main) this.main.active = true;
        if (this.hidden) this.hidden.active = false;
        this.data = null;
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
                    if (!this.node?.isValid || !this._despawnTarget) return;
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

    /** Port từ Unity Yarn.ShakeNeighbors — adapted cho Cocos.
     *  Cocos builtin physics KHÔNG có `sweepSphereAll`/OverlapSphere (chỉ có PhysX backend).
     *  → Fallback: iterate GameManager.allYarns registry, check distance squared.
     *  Performance OK với count yarn vừa phải (<200). */
    /** Pixel-grid neighbor lookup: dùng data.x/y + GameManager.getYarnAt — O(1) per cell.
     *  Independent của scale/world space, deterministic, fast. Skip Creator-spawned transient
     *  yarns (data.x < 0 hoặc y < 0 → không có trong pixel map). */
    private shakeNeighbors(): void {
        if (!this.data) return;
        const gm = GameManager.instance;
        if (!gm) return;

        const x = this.data.x;
        const y = this.data.y;
        if (x < 0 || y < 0) return;  // transient yarn, không có grid coords

        const r = Math.max(1, Math.floor(this.neighborRadiusCells));
        const rSq = r * r;

        for (let dx = -r; dx <= r; dx++) {
            for (let dy = -r; dy <= r; dy++) {
                if (dx === 0 && dy === 0) continue;
                if (dx * dx + dy * dy > rSq) continue;  // circle constraint
                const neighbor = gm.getYarnAt(x + dx, y + dy);
                if (neighbor && neighbor !== this) neighbor.shake();
            }
        }
    }

    /** Reveal mystery yarn — chuyển từ hidden visual sang main visual.
     *  Idempotent: gọi nhiều lần OK. Tách khỏi shake() để reveal LUÔN fire dù shake đang debounce. */
    public reveal(): void {
        if (this.hidden) this.hidden.active = false;
        if (this.main) this.main.active = true;
    }

    public shake(): void {
        // QUAN TRỌNG: reveal TRƯỚC guard — nếu yarn đang shake (từ neighbor khác trước đó)
        // và shake này bị skip, reveal vẫn phải xảy ra. Match Unity intent.
        this.reveal();

        if (this._shakeTween) return;
        this._shakeOrigin.set(this.node.position);
        this._shakeTarget.t = 0;

        const angle = Math.random() * Math.PI * 2;
        const dirX  = Math.cos(angle);
        const dirZ  = Math.sin(angle);

        this._shakeTween = tween(this._shakeTarget)
            .to(this.shakeDuration, { t: 1 }, {
                onUpdate: () => {
                    if (!this.node?.isValid || !this._shakeTarget) return;
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
        if (!this.meshRenderer) return;
        // Đẩy color qua per-instance attribute thay vì setProperty (uniform) — giữ shared
        // material asset để Cocos batch tất cả yarn thành 1 instanced draw call.
        // Shader mk-toon-simple nhân `albedoColor * v_instanceColor` trong frag, nên giữ
        // albedoColor material = (1,1,1,1) (trắng), v_instanceColor = màu yarn thực.
        const buf = Yarn._instColorBuf;
        buf[0] = color.r / 255;
        buf[1] = color.g / 255;
        buf[2] = color.b / 255;
        buf[3] = color.a / 255;
        this.meshRenderer.setInstancedAttribute('a_instanceColor', buf);
    }

    public setHidden(): void {
        if (this.main) this.main.active = false;
        if (this.hidden) this.hidden.active = true;
        if (!this.main || !this.hidden) {
            console.warn('[Yarn] setHidden called but main/hidden not wired in prefab', this.node.name);
        }
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
                    if (!this.node?.isValid || !this._arcTarget) return;
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
