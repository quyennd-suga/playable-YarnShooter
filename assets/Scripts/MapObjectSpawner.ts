import { _decorator, Component, Prefab, NodePool, instantiate, Node, Vec3 } from 'cc';
const { ccclass, property } = _decorator;

@ccclass('MapObjectSpawner')
export class MapObjectSpawner extends Component {
    public static instance: MapObjectSpawner = null;

    @property(Prefab) public prefabYarn: Prefab = null;
    @property(Prefab) public prefabBobbin: Prefab = null;
    @property(Prefab) public prefabLock: Prefab = null;
    @property(Prefab) public prefabMover: Prefab = null;
    @property(Prefab) public prefabPipe: Prefab = null;
    @property(Prefab) public prefabFrozen: Prefab = null;
    @property(Prefab) public prefabConnection: Prefab = null;
    /** FX particle khi Mystery Bobbin reveal (port từ Unity MapObjectSpawner.prefabFxBobbin). */
    @property(Prefab) public prefabFxBobbin: Prefab = null;
    /** Thời gian sống của fxBobbin trước khi tự release về pool (tương đương PoolableParticle bên Unity). */
    @property public fxBobbinLifetime: number = 1.5;

    private yarnPool: NodePool = new NodePool();
    private bobbinPool: NodePool = new NodePool();
    private lockPool: NodePool = new NodePool();
    private moverPool: NodePool = new NodePool();
    private pipePool: NodePool = new NodePool();
    private frozenPool: NodePool = new NodePool();
    private connectionPool: NodePool = new NodePool();
    private fxBobbinPool: NodePool = new NodePool();

    onLoad() {
        if (!MapObjectSpawner.instance) {
            MapObjectSpawner.instance = this;
        } else {
            this.node.destroy();
            return;
        }

        // Prewarm (khởi tạo sẵn) để tránh giật lag lúc đầu game
        this.prewarm(this.yarnPool, this.prefabYarn, 20);
        this.prewarm(this.bobbinPool, this.prefabBobbin, 20);
    }

    private prewarm(pool: NodePool, prefab: Prefab, count: number) {
        if (!prefab) return;
        for (let i = 0; i < count; i++) {
            pool.put(instantiate(prefab));
        }
    }

    private getNodeFromPool(pool: NodePool, prefab: Prefab, fallbackName: string): Node {
        if (pool.size() > 0) {
            return pool.get();
        }
        if (prefab) {
            return instantiate(prefab);
        }
        // Fallback: nếu chưa kéo Prefab, tạo Node rỗng (để code không bị lỗi null)
        return new Node(fallbackName);
    }

    // --- YARN ---
    public getYarn(parent: Node): Node {
        let node = this.getNodeFromPool(this.yarnPool, this.prefabYarn, "Yarn");
        node.setParent(parent);
        return node;
    }
    public releaseYarn(node: Node) { this.yarnPool.put(node); }

    // --- BOBBIN ---
    public getBobbin(parent: Node): Node {
        let node = this.getNodeFromPool(this.bobbinPool, this.prefabBobbin, "Bobbin");
        node.setParent(parent);
        return node;
    }
    public releaseBobbin(node: Node) { this.bobbinPool.put(node); }

    // --- LOCK ---
    public getLock(parent: Node): Node {
        let node = this.getNodeFromPool(this.lockPool, this.prefabLock, "Lock");
        node.setParent(parent);
        return node;
    }
    public releaseLock(node: Node) { this.lockPool.put(node); }

    // --- MOVER ---
    public getMover(parent: Node): Node {
        let node = this.getNodeFromPool(this.moverPool, this.prefabMover, "Mover");
        node.setParent(parent);
        return node;
    }
    public releaseMover(node: Node) { this.moverPool.put(node); }

    // --- PIPE ---
    public getPipe(parent: Node): Node {
        let node = this.getNodeFromPool(this.pipePool, this.prefabPipe, "Pipe");
        node.setParent(parent);
        return node;
    }
    public releasePipe(node: Node) { this.pipePool.put(node); }

    // --- FROZEN ---
    public getFrozen(parent: Node): Node {
        let node = this.getNodeFromPool(this.frozenPool, this.prefabFrozen, "Frozen");
        node.setParent(parent);
        return node;
    }
    public releaseFrozen(node: Node) { this.frozenPool.put(node); }

    // --- CONNECTION ---
    public getConnection(parent: Node): Node {
        let node = this.getNodeFromPool(this.connectionPool, this.prefabConnection, "ConnectionGroup");
        node.setParent(parent);
        return node;
    }
    public releaseConnection(node: Node) { this.connectionPool.put(node); }

    // --- FX BOBBIN (Mystery reveal vfx) ---
    /** Port 1:1 từ Unity MapObjectSpawner.SpawnFxBobbin: lấy fx từ pool, đặt vị trí, play rồi tự release. */
    public spawnFxBobbin(worldPos: Vec3): Node {
        if (!this.prefabFxBobbin) return null;
        const fx = this.getNodeFromPool(this.fxBobbinPool, this.prefabFxBobbin, "FxBobbin");
        fx.setParent(this.node);
        fx.setWorldPosition(worldPos);
        fx.active = true;
        this.scheduleOnce(() => {
            if (fx && fx.isValid) {
                fx.active = false;
                this.fxBobbinPool.put(fx);
            }
        }, this.fxBobbinLifetime);
        return fx;
    }
}
