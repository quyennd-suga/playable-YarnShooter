import {
    _decorator, Component, Node, MeshRenderer, Color, Vec3, Quat, Label,
    ParticleSystem, tween, Tween,
} from 'cc';
import { Yarn } from './Yarn';
import { MapObjectSpawner } from './MapObjectSpawner';
import { MaterialPalette } from './MaterialPalette';
import { GameManager } from './Core/GameManager';
import { PixelPipeData, PixelPipePixelGroupData } from './Data/LevelInterfaces';
const { ccclass, property } = _decorator;

/**
 * Port 1:1 từ Unity Creator.cs.
 *
 * Creator đứng tại 1 vị trí trên above layer. Lắng nghe Yarn.onDespawned.
 * Khi yarn (cùng material với group hiện tại) bị bobbin bắn → Creator:
 *   1. Trừ count group hiện tại
 *   2. Spawn 1 yarn mới tại Creator, bay vòng cung tới chỗ yarn vừa mất
 *   3. Punch animation phồng nhẹ Creator
 *   4. Khi count=0 → advance queue → group tiếp theo
 *   5. Khi hết queue → FlipAndRelease + về pool
 */
@ccclass('Creator')
export class Creator extends Component {

    @property(MeshRenderer) public meshRenderer: MeshRenderer = null;
    @property(Label) public textCount: Label = null;
    /** Particle FX bật khi Creator flip release. Optional. */
    @property(ParticleSystem) public fx: ParticleSystem = null;

    @property public flyDuration: number = 0.5;
    @property public arcHeight: number = 0.3;

    @property public flipDuration: number = 0.5;
    @property public flipJumpHeight: number = 0.5;

    /** Property name cho material color (rope-scale-independent → 'mainColor'; standard → 'albedoColor'). */
    @property public colorProperty: string = 'albedoColor';

    public scale: number = 1;

    private _queue: PixelPipePixelGroupData[] = [];
    private _currentIndex: number = 0;
    private _spawnParent: Node = null;
    private _meshBaseScale: Vec3 = new Vec3(1, 1, 1);
    private _meshMat: any = null;

    private _onDespawnHandler: (m: number, p: Vec3) => boolean = null;

    // ─── Setup ────────────────────────────────────────────────────────────────────

    public setup(data: PixelPipeData, spawnParent: Node): void {
        this._spawnParent = spawnParent;
        this._currentIndex = 0;

        // scale từ sqrt(gridPoints.Count): 1→1, 9→3, ... (Unity (int) cast = floor)
        this.scale = Math.floor(Math.sqrt(data.GridPoints.length));

        if (this.meshRenderer) {
            const meshScale = this.scale === 3 ? 1.5 : 1;
            this.meshRenderer.node.setScale(meshScale, meshScale, meshScale);
            this._meshBaseScale.set(meshScale, meshScale, meshScale);
            this._meshMat = this.meshRenderer.getMaterialInstance(0);
        }

        // Deep clone queue để không sửa data gốc
        this._queue = [];
        if (data.Queue) {
            for (const g of data.Queue) {
                this._queue.push({ Material: g.Material, Count: g.Count });
            }
        }

        this._applyVisuals(this._currentIndex);

        // Subscribe Yarn despawn event
        this._onDespawnHandler = (m: number, p: Vec3) => this._onYarnDespawned(m, p);
        Yarn.onDespawned.push(this._onDespawnHandler);
    }

    // ─── Event handler ────────────────────────────────────────────────────────────

    private _onYarnDespawned(material: number, despawnedWorldPos: Vec3): boolean {
        if (!this._queue || this._currentIndex >= this._queue.length) return false;

        const current = this._queue[this._currentIndex];
        if (current.Material !== material || current.Count <= 0) return false;

        current.Count--;
        if (this.textCount) this.textCount.string = current.Count.toString();
        this._spawnYarnAndFly(material, despawnedWorldPos);

        if (current.Count === 0) {
            this._currentIndex++;
            this._advanceQueue();
        }

        return true;
    }

    /** Skip groups Count<=0, apply visuals cho group hiện tại, hoặc flip release nếu hết. */
    private _advanceQueue(): void {
        while (this._currentIndex < this._queue.length && this._queue[this._currentIndex].Count <= 0) {
            this._currentIndex++;
        }

        if (this._currentIndex < this._queue.length) {
            this._applyVisuals(this._currentIndex);
        } else {
            if (this.textCount) this.textCount.node.active = false;
            this._flipAndRelease();
        }
    }

    private _applyVisuals(index: number): void {
        const g = this._queue[index];
        if (this._meshMat) {
            const color = MaterialPalette.getMaterialById(g.Material).color;
            this._meshMat.setProperty(this.colorProperty, color);
        }
        if (this.textCount) {
            this.textCount.string = g.Count.toString();
            this.textCount.node.active = true;
        }
    }

    // ─── Spawn + fly ─────────────────────────────────────────────────────────────

    private _spawnYarnAndFly(material: number, targetWorldPos: Vec3): void {
        if (!this._spawnParent) return;

        const yarnNode = MapObjectSpawner.instance.getYarn(this._spawnParent);
        if (!yarnNode) return;
        const yarn = yarnNode.getComponent(Yarn);
        if (!yarn) return;

        // Set yarn properties
        yarn.despawnDuration = 0.15;
        yarn.despawnOvershoot = 3;
        // Sentinel x=-1, y=-1: Creator-spawned yarn KHÔNG vào pixel grid map của GameManager
        // (tránh clash key "0,0" khi có nhiều Creator yarn cùng tồn tại + giữ shakeNeighbors
        // chỉ tác động đến yarn pixel gốc).
        yarn.data = { x: -1, y: -1, material };

        // Xuất phát từ Creator
        const creatorWorldPos = this.node.worldPosition;
        yarnNode.setWorldPosition(creatorWorldPos);
        yarnNode.setRotation(Quat.IDENTITY);
        yarnNode.setScale(1, 1, 1);

        // Set color của yarn
        yarn.setColor(MaterialPalette.getMaterialById(material).color);

        // Register với GameManager (match MapGenerator initial spawn pattern) — đảm bảo
        // yarn mới được track cho win condition / list query nếu cần.
        GameManager.instance?.registerYarn(yarn);

        // Bay vòng cung tới chỗ yarn vừa mất
        yarn.flyArc(creatorWorldPos.clone(), targetWorldPos.clone(), this.flyDuration, this.arcHeight);

        this._punchMeshScale();
    }

    /** Port Unity DOPunchScale: phồng 1.1x rồi co lại OutElastic. */
    private _punchMeshScale(): void {
        if (!this.meshRenderer) return;
        const node = this.meshRenderer.node;
        Tween.stopAllByTarget(node);
        node.setScale(this._meshBaseScale);
        const peak = new Vec3(
            this._meshBaseScale.x * 1.1,
            this._meshBaseScale.y * 1.1,
            this._meshBaseScale.z * 1.1,
        );
        tween(node)
            .to(0.12, { scale: peak }, { easing: 'quadOut' })
            .to(0.2, { scale: this._meshBaseScale.clone() }, { easing: 'elasticOut' })
            .start();
    }

    // ─── SuperBobbin purge ────────────────────────────────────────────────────────

    /** SuperBobbin: clear count của material match, advance queue nếu hiện tại bị purge. */
    public purgeMaterial(material: number): void {
        if (!this._queue) return;
        let affected = false;
        for (const g of this._queue) {
            if (g.Material !== material || g.Count <= 0) continue;
            g.Count = 0;
            affected = true;
        }
        if (!affected) return;

        if (this._currentIndex < this._queue.length && this._queue[this._currentIndex].Count <= 0) {
            this._advanceQueue();
        } else if (this._currentIndex < this._queue.length) {
            this._applyVisuals(this._currentIndex);
        }
    }

    // ─── Flip release ────────────────────────────────────────────────────────────

    private _flipAndRelease(): void {
        // Unsubscribe ngay để không nhận event mới trong lúc bay
        this._unsubscribe();

        const startPos = this.node.worldPosition.clone();
        const startRot = this.node.rotation.clone();
        const endRot = new Quat();
        Quat.fromEuler(endRot, 0, Math.random() * 30, 180);

        const ctx = { t: 0 };
        const tmpPos = new Vec3();
        const tmpRot = new Quat();

        tween(ctx)
            .to(this.flipDuration, { t: 1 }, {
                onUpdate: () => {
                    if (!this.node?.isValid) return;
                    const t = Math.max(0, Math.min(1, ctx.t));
                    // Arc Y theo sin(πt)
                    const arc = this.flipJumpHeight * Math.sin(Math.PI * t);
                    tmpPos.set(startPos.x, startPos.y + arc, startPos.z);
                    this.node.setWorldPosition(tmpPos);
                    // Slerp rotation
                    Quat.slerp(tmpRot, startRot, endRot, t);
                    this.node.setRotation(tmpRot);
                },
            })
            .call(() => {
                if (!this.node?.isValid) return;
                this.node.setWorldPosition(startPos);
                this.node.setRotation(endRot);
                if (this.fx) this.fx.play();
                this.node.setScale(Vec3.ZERO);
                // Unity comment out ReleaseCreator — Cocos port: thực sự release để tránh leak node
                MapObjectSpawner.instance.releaseCreator(this);
            })
            .start();
    }

    // ─── Pool reset ───────────────────────────────────────────────────────────────

    public resetForPool(): void {
        this._unsubscribe();
        Tween.stopAllByTarget(this.node);
        if (this.meshRenderer) Tween.stopAllByTarget(this.meshRenderer.node);
        this.unscheduleAllCallbacks();

        this._queue = [];
        this._currentIndex = 0;
        this._spawnParent = null;

        this.node.setPosition(0, 0, 0);
        this.node.setRotation(Quat.IDENTITY);
        this.node.setScale(1, 1, 1);

        if (this.textCount) this.textCount.node.active = true;
    }

    private _unsubscribe(): void {
        if (this._onDespawnHandler) {
            const idx = Yarn.onDespawned.indexOf(this._onDespawnHandler);
            if (idx >= 0) Yarn.onDespawned.splice(idx, 1);
            this._onDespawnHandler = null;
        }
    }
}
