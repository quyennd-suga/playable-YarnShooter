import { _decorator, Component, Prefab, NodePool, instantiate, Node, Vec3 } from 'cc';
import { ConnectionChild } from './ConnectionChild';
import { Connection } from './Core/Connection';
import { Bobbin } from './Bobbin';
import { BobbinWall } from './BobbinWall';
import { BobbinWallChild } from './BobbinWallChild';
import { BobbinWallBorder } from './BobbinWallBorder';
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
    /** Rope cylinder nối 2 bobbin trong Connection (port từ Unity prefabConnectionChild). */
    @property(Prefab) public prefabConnectionChild: Prefab = null;
    /** FX particle khi Mystery Bobbin reveal (port từ Unity MapObjectSpawner.prefabFxBobbin). */
    @property(Prefab) public prefabFxBobbin: Prefab = null;
    /** Thời gian sống của fxBobbin trước khi tự release về pool (tương đương PoolableParticle bên Unity). */
    @property public fxBobbinLifetime: number = 1.5;

    // ─── BobbinWall (port 1:1 từ Unity MapObjectSpawner) ─────────────────────────
    /** Prefab wall container — chứa center + scoreText, KHÔNG có mesh child sẵn. */
    @property(Prefab) public prefabBobbinWall: Prefab = null;
    /** Prefab 1 ô đơn (cell) trong grid. Mỗi cell có MeshRenderer + 4 anchor góc. */
    @property(Prefab) public prefabBobbinWallChild: Prefab = null;
    /** Prefab thanh viền ở 4 góc wall. */
    @property(Prefab) public prefabBobbinWallGoc: Prefab = null;
    /** Prefab thanh viền ở các cạnh (top/bottom/left/right) của wall. */
    @property(Prefab) public prefabBobbinWallCanh: Prefab = null;

    private yarnPool: NodePool = new NodePool();
    private bobbinPool: NodePool = new NodePool();
    private lockPool: NodePool = new NodePool();
    private moverPool: NodePool = new NodePool();
    private pipePool: NodePool = new NodePool();
    private frozenPool: NodePool = new NodePool();
    private connectionPool: NodePool = new NodePool();
    private connectionChildPool: NodePool = new NodePool();
    private fxBobbinPool: NodePool = new NodePool();
    private bobbinWallPool: NodePool = new NodePool();
    private bobbinWallChildPool: NodePool = new NodePool();
    private bobbinWallGocPool: NodePool = new NodePool();
    private bobbinWallCanhPool: NodePool = new NodePool();

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
        // NodePool.put set active=false → cần kích hoạt lại khi lấy ra
        node.active = true;
        return node;
    }
    /** Trả bobbin về pool. Port 1:1 từ Unity MapObjectSpawner pool actionOnRelease:
     *  gọi Bobbin.resetState() để clear toàn bộ runtime flag trước khi recycle. */
    public releaseBobbin(node: Node) {
        if (!node?.isValid) return;
        const b = node.getComponent(Bobbin);
        if (b) b.resetState();
        node.active = false;
        this.bobbinPool.put(node);
    }

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

    // --- CONNECTION (cluster host node) ---
    public getConnection(parent: Node): Node {
        let node = this.getNodeFromPool(this.connectionPool, this.prefabConnection, "ConnectionGroup");
        node.setParent(parent);
        node.active = true;
        return node;
    }
    public releaseConnection(node: Node) {
        if (!node?.isValid) return;
        // Port 1:1 từ Unity: pool's actionOnRelease gọi c.ResetForPool() → release tất cả ConnectionChild
        const comp = node.getComponent(Connection);
        if (comp) comp.resetForPool();
        node.active = false;
        this.connectionPool.put(node);
    }

    // --- CONNECTION CHILD (rope cylinder nối 2 bobbin) ---
    /** Lấy 1 ConnectionChild (rope cylinder) từ pool, parent dưới `parent`. */
    public getConnectionChild(parent: Node): ConnectionChild {
        const node = this.getNodeFromPool(this.connectionChildPool, this.prefabConnectionChild, "ConnectionChild");
        node.setParent(parent);
        node.active = true;
        const comp = node.getComponent(ConnectionChild) ?? node.addComponent(ConnectionChild);
        return comp;
    }
    public releaseConnectionChild(child: ConnectionChild) {
        if (!child?.node?.isValid) return;
        child.resetForPool();
        child.node.active = false;
        this.connectionChildPool.put(child.node);
    }

    // --- BOBBIN WALL ---
    /** Lấy BobbinWall container từ pool. Caller sẽ gán material/score rồi gọi setup(areaX, areaY, cellSize, color). */
    public getBobbinWall(parent: Node): BobbinWall | null {
        const node = this.getNodeFromPool(this.bobbinWallPool, this.prefabBobbinWall, "BobbinWall");
        node.setParent(parent);
        node.active = true;
        return node.getComponent(BobbinWall) ?? node.addComponent(BobbinWall);
    }
    public releaseBobbinWall(wall: BobbinWall) {
        if (!wall?.node?.isValid) return;
        wall.resetForPool();
        wall.node.active = false;
        this.bobbinWallPool.put(wall.node);
    }

    public getBobbinWallChild(parent: Node): BobbinWallChild | null {
        const node = this.getNodeFromPool(this.bobbinWallChildPool, this.prefabBobbinWallChild, "BobbinWallChild");
        node.setParent(parent);
        node.active = true;
        return node.getComponent(BobbinWallChild) ?? node.addComponent(BobbinWallChild);
    }
    public releaseBobbinWallChild(child: BobbinWallChild) {
        if (!child?.node?.isValid) return;
        child.resetForPool();
        child.node.active = false;
        this.bobbinWallChildPool.put(child.node);
    }

    public getBobbinWallGoc(parent: Node): BobbinWallBorder | null {
        const node = this.getNodeFromPool(this.bobbinWallGocPool, this.prefabBobbinWallGoc, "BobbinWallGoc");
        node.setParent(parent);
        node.active = true;
        return node.getComponent(BobbinWallBorder) ?? node.addComponent(BobbinWallBorder);
    }
    public releaseBobbinWallGoc(border: BobbinWallBorder) {
        if (!border?.node?.isValid) return;
        border.resetForPool();
        border.node.active = false;
        this.bobbinWallGocPool.put(border.node);
    }

    public getBobbinWallCanh(parent: Node): BobbinWallBorder | null {
        const node = this.getNodeFromPool(this.bobbinWallCanhPool, this.prefabBobbinWallCanh, "BobbinWallCanh");
        node.setParent(parent);
        node.active = true;
        return node.getComponent(BobbinWallBorder) ?? node.addComponent(BobbinWallBorder);
    }
    public releaseBobbinWallCanh(border: BobbinWallBorder) {
        if (!border?.node?.isValid) return;
        border.resetForPool();
        border.node.active = false;
        this.bobbinWallCanhPool.put(border.node);
    }

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
