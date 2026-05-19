import { _decorator, Component, JsonAsset, Node, Vec3 } from 'cc';
import { MaterialPalette } from './MaterialPalette';
import { BoardScaler } from './BoardScaler';
import { Yarn } from './Yarn';
import { Bobbin } from './Bobbin';
import { MapObjectSpawner } from './MapObjectSpawner';
import { LevelManager } from './Core/LevelManager';
import { GameManager } from './Core/GameManager';
import { TrayManager } from './Core/TrayManager';
import { Connection } from './Core/Connection';
import { Lock } from './Lock';
import { PixelData, FacingDirection } from './Data/LevelInterfaces';

const { ccclass, property } = _decorator;

import { LevelData } from './Data/LevelInterfaces';

@ccclass('MapGenerator')
export class MapGenerator extends Component {

    @property(JsonAsset) public levelData: JsonAsset = null;
    @property(Node) public aboveParent: Node = null;
    @property(Node) public underParent: Node = null;
    @property(BoardScaler) public boardScaler: BoardScaler = null;

    @property public bobbinColumnSpacing: number = 0.15;
    @property public bobbinRowSpacing: number = 0.15;

    public idToBobbin: Map<number, Node> = new Map<number, Node>();

    start() {
        this.generateMap();
        
        TrayManager.instance.resetForNewLevel();
    }

    public generateMap(): void {
        this.clearMap();

        const data = this.levelData.json as LevelData;

        // 1. Generate Above Layer (Yarns + BobbinWalls)
        if (data.PixelImage && data.PixelImage.pixels) {
            const pixels = data.PixelImage.pixels;
            this.boardScaler.calculateCenter(pixels);

            const parent = this.aboveParent ?? this.node;

            // Port 1:1 từ Unity MapGenerator: pixel ở vị trí (x,y) có entry trong pixelHealths
            // sẽ spawn BobbinWall thay cho Yarn — exclude khỏi vòng spawn yarn.
            const healthSet = this._buildHealthPositionSet(data);
            const yarnPixels = healthSet.size > 0
                ? pixels.filter(p => !healthSet.has(this._pixelKey(p.x, p.y)))
                : pixels;

            // Port 1:1 từ Unity BuildHiddenSet: pixels nằm trong surprisePixels sẽ hidden visual
            // ("?") thay vì màu thật — Mystery Yarn. Reveal khi neighbor bị bắn → shakeNeighbors.
            const hiddenSet = this._buildHiddenSet(data);

            for (let i = 0; i < yarnPixels.length; i++) {
                const pixel = yarnPixels[i];
                const node = MapObjectSpawner.instance.getYarn(parent);

                const pos = this.boardScaler.getChildLocalPosition(pixel.x, pixel.y);
                node.setPosition(pos.x, pos.y, pos.z);

                const yarnComp = node.getComponent(Yarn);
                if (yarnComp) {
                    yarnComp.setColor(MaterialPalette.getMaterialById(pixel.material).color);
                    yarnComp.data = pixel;
                    GameManager.instance?.registerYarn(yarnComp);
                    if (hiddenSet.has(this._pixelKey(pixel.x, pixel.y))) {
                        yarnComp.setHidden();
                    }
                }
            }

            // Build lookup (x,y) → PixelData để spawnBobbinWalls lấy areaX/areaY/material
            const pixelLookup = new Map<string, PixelData>();
            for (const p of pixels) pixelLookup.set(this._pixelKey(p.x, p.y), p);
            this.spawnBobbinWalls(data, pixelLookup, parent);

            // Spawn Keys trên above layer (cùng yarns) — port 1:1 từ Unity SpawnKeys.
            this.spawnKeys(data, parent);

            // Spawn Barriers trên above layer — port 1:1 từ Unity SpawnBarriers.
            this.spawnBarriers(data, parent);

            // Spawn Creators trên above layer — port 1:1 từ Unity SpawnCreators.
            this.spawnCreators(data, parent);

            // Spawn Walls trên above layer — port 1:1 từ Unity SpawnWalls (decor thuần visual).
            this.spawnWalls(data, parent);

            this.boardScaler.adjustScale();
        }

        // 2. Generate Under Layer (Bobbins - Placeholders)
        if (data.QueueGroup && data.QueueGroup.queues) {
            LevelManager.instance.setupRows(data.QueueGroup.queues.length);
        }
        this.spawnBobbins(data);

        // 3. Modifiers & Special Bobbins (Placeholders)
        this.spawnLocks(data);
        this.spawnMovers(data);
        this.spawnPipes(data);
        this.spawnFrozenShooters(data);
        this.spawnConnections(data);
        this.spawnMysteryShooters(data);

        // 4. Cập nhật lại các Bobbin ngoài cùng được phép click
        LevelManager.instance.initQueueStates();
    }

    private spawnBobbins(data: LevelData): void {
        if (!data.QueueGroup || !data.QueueGroup.queues) return;
        const queues = data.QueueGroup.queues;
        const parent = this.underParent ?? this.node;

        const totalWidth = (queues.length - 1) * this.bobbinColumnSpacing;
        const startX = -totalWidth / 2;

        for (let qIdx = 0; qIdx < queues.length; qIdx++) {
            const queue = queues[qIdx];
            if (!queue.shooters) continue;

            // Cocos KHÔNG flip X như Unity (BoardScaler dùng +pixel.x → +world.x), nên KHÔNG cần
            // áp dụng Unity's mirror formula `(queues.Count - 1 - qIdx)`. Dùng qIdx trực tiếp để
            // queue[0] ở -X (cùng phía yarn pixel.x=0) — match alignment yarn↔bobbin trong Cocos.
            const colX = startX + qIdx * this.bobbinColumnSpacing;

            for (let sIdx = 0; sIdx < queue.shooters.length; sIdx++) {
                const shooter = queue.shooters[sIdx];
                if (shooter.id === 0) continue;

                // Sử dụng Pool để đẻ Bobbin
                let bobbinNode = MapObjectSpawner.instance.getBobbin(parent);
                bobbinNode.name = "Bobbin_" + shooter.id;

                bobbinNode.setPosition(colX, 0, sIdx * this.bobbinRowSpacing);

                // Đổi màu Bobbin tương tự như Yarn
                const color = MaterialPalette.getMaterialById(shooter.material).color;
                const bobbinComp = bobbinNode.getComponent(Bobbin);
                if (bobbinComp) {
                    bobbinComp.setColor(color);
                    bobbinComp.data = shooter;
                    bobbinComp.setScore(shooter.ammo);
                    LevelManager.instance.addBobbinToRow(qIdx, bobbinComp);
                }

                // Lưu vào map để sau này replace bởi Lock/Mover/Pipe
                this.idToBobbin.set(shooter.id, bobbinNode);
            }
        }
    }

    /** Port 1:1 từ Unity MapGenerator.SpawnLocks:
     *  Thay thế Bobbin trong _rowQueues TẠI CHỖ bằng Lock — KHÔNG destroy bobbin từ scene
     *  trước khi rời queue, vì LevelManager._rowQueues sở hữu QueueItem references. */
    private spawnLocks(data: LevelData): void {
        if (!data.Locks || !data.Locks.Shooters) return;
        const parent = this.underParent ?? this.node;

        for (let lockData of data.Locks.Shooters) {
            const bobbinNode = this.idToBobbin.get(lockData.ShooterId);
            if (!bobbinNode) continue;
            const bobbinComp = bobbinNode.getComponent(Bobbin);
            if (!bobbinComp) continue;

            const lockNode = MapObjectSpawner.instance.getLock(parent);
            lockNode.name = "Lock_" + lockData.ShooterId;
            lockNode.setPosition(bobbinNode.position);
            const lockComp = lockNode.getComponent(Lock) ?? lockNode.addComponent(Lock);

            // Replace bobbin tại chỗ trong _rowQueues — trailing items giữ nguyên vị trí.
            const replaced = LevelManager.instance?.replaceBobbinWithLock(bobbinComp, lockComp);
            console.log('[spawnLocks] ShooterId=', lockData.ShooterId, 'replaced=', replaced,
                'lockNode pos=', lockNode.position, 'worldPos=', lockNode.worldPosition);
            if (replaced) {
                // Release bobbin về pool (silent, không animation) vì nó đã được Lock thay thế.
                MapObjectSpawner.instance.releaseBobbin(bobbinNode);
            } else {
                // Fallback: nếu bobbin chưa có trong rowQueues (corner case), giữ logic cũ.
                bobbinNode.destroy();
            }
            this.idToBobbin.delete(lockData.ShooterId);
        }
    }

    private spawnMovers(data: LevelData): void {
        if (!data.Mowers || !data.Mowers.Shooters) return;
        const parent = this.underParent ?? this.node;

        for (let moverData of data.Mowers.Shooters) {
            const bobbinNode = this.idToBobbin.get(moverData.ShooterId);
            if (!bobbinNode) continue;

            let moverNode = MapObjectSpawner.instance.getMover(parent);
            moverNode.name = "Mover_" + moverData.ShooterId;
            moverNode.setPosition(bobbinNode.position);

            // Mover cũng thay thế Bobbin
            bobbinNode.destroy();
            this.idToBobbin.delete(moverData.ShooterId);
        }
    }

    /** Port 1:1 từ Unity MapGenerator.SpawnPipes:
     *  Thay thế Bobbin trong _rowQueues TẠI CHỖ bằng Pipe — KHÔNG destroy bobbinNode trực tiếp,
     *  vì LevelManager._rowQueues sở hữu QueueItem references. */
    private spawnPipes(data: LevelData): void {
        if (!data.ShooterPipes || !data.ShooterPipes.Pipes) return;
        const parent = this.underParent ?? this.node;

        for (const pipeData of data.ShooterPipes.Pipes) {
            const bobbinNode = this.idToBobbin.get(pipeData.ShooterId);
            if (!bobbinNode) continue;
            const bobbinComp = bobbinNode.getComponent(Bobbin);
            if (!bobbinComp) continue;

            const pipe = MapObjectSpawner.instance.getPipe(parent);
            if (!pipe) continue;
            pipe.node.name = "Pipe_" + pipeData.ShooterId;
            pipe.node.setPosition(bobbinNode.position);
            pipe.node.setRotation(bobbinNode.rotation);
            pipe.node.setScale(1, 1, 1);
            pipe.data = pipeData;
            pipe.updateText();

            // Replace bobbin tại chỗ trong _rowQueues — trailing items giữ nguyên vị trí.
            const replaced = LevelManager.instance?.replaceBobbinWithPipe(bobbinComp, pipe);
            if (replaced) {
                // Release bobbin về pool silent (đã được Pipe thay thế).
                MapObjectSpawner.instance.releaseBobbin(bobbinNode);
            } else {
                bobbinNode.destroy();
            }
            this.idToBobbin.delete(pipeData.ShooterId);
        }
    }

    private spawnFrozenShooters(data: LevelData): void {
        if (!data.FrozenShooters || !data.FrozenShooters.IceBlocks) return;

        for (let iceData of data.FrozenShooters.IceBlocks) {
            const bobbinNode = this.idToBobbin.get(iceData.ShooterId);
            if (!bobbinNode) continue;

            // Frozen block bọc lấy bobbin, không thay thế
            let frozenNode = MapObjectSpawner.instance.getFrozen(bobbinNode);
            frozenNode.name = `Frozen_${iceData.IceBlockCount}HP`;
        }
    }

    // ─── BobbinWall ──────────────────────────────────────────────────────────────

    private _pixelKey(x: number, y: number): string { return `${x},${y}`; }

    private _buildHealthPositionSet(data: LevelData): Set<string> {
        const set = new Set<string>();
        const healths = data.PixelImage?.pixelHealths;
        if (healths) for (const ph of healths) set.add(this._pixelKey(ph.x, ph.y));
        return set;
    }

    /** Port 1:1 từ Unity MapGenerator.BuildHiddenSet — tập (x,y) keys của Mystery Yarns. */
    private _buildHiddenSet(data: LevelData): Set<string> {
        const set = new Set<string>();
        const hidden = data.PixelImage?.surprisePixels?.Pixels;
        if (hidden) for (const ph of hidden) set.add(this._pixelKey(ph.x, ph.y));
        return set;
    }

    /** Port 1:1 từ Unity MapGenerator.SpawnBobbinWalls:
     *  Mỗi PixelHealthData → 1 BobbinWall đặt tại pixel (x,y), lấy areaX/areaY/material
     *  từ PixelData cùng (x,y), score = pixelHealth.health. */
    private spawnBobbinWalls(data: LevelData, pixelLookup: Map<string, PixelData>, parent: Node): void {
        const healths = data.PixelImage?.pixelHealths;
        if (!healths || healths.length === 0) return;
        const cellSize = this.boardScaler.cellSize;

        for (const ph of healths) {
            const pixel = pixelLookup.get(this._pixelKey(ph.x, ph.y));
            if (!pixel) continue;
            const wall = MapObjectSpawner.instance.getBobbinWall(parent);
            if (!wall) continue;

            const pos = this.boardScaler.getChildLocalPosition(pixel.x, pixel.y);
            wall.node.setPosition(pos.x, pos.y, pos.z);
            // Reset rotation/scale phòng trường hợp pool reuse mang theo state cũ
            wall.node.setRotationFromEuler(0, 0, 0);
            wall.node.setScale(1, 1, 1);

            wall.material = pixel.material;
            wall.score = ph.health;
            const color = MaterialPalette.getMaterialById(pixel.material).color;
            wall.setup(pixel.areaX ?? 1, pixel.areaY ?? 1, cellSize, color);
        }
    }

    // ─── Key ─────────────────────────────────────────────────────────────────────

    /** Port 1:1 từ Unity MapGenerator.SpawnKeys:
     *  Mỗi KeyData → 1 Key đặt tại centroid (avg X, avg Y) của tất cả GridPoints.
     *  Parent = aboveParent (cùng layer với Yarns) để collider raycast hit được. */
    private spawnKeys(data: LevelData, parent: Node): void {
        const keys = data.PixelImage?.keys?.Keys;
        if (!keys || keys.length === 0) return;

        for (const keyData of keys) {
            if (!keyData.GridPoints || keyData.GridPoints.length === 0) continue;

            // Tính centroid
            let sumX = 0, sumZ = 0;
            for (const pt of keyData.GridPoints) { sumX += pt.x; sumZ += pt.y; }
            const avgX = sumX / keyData.GridPoints.length;
            const avgZ = sumZ / keyData.GridPoints.length;

            // Dùng BoardScaler để map sang world pos giống yarn (Cocos convention, không flip X)
            const pos = this.boardScaler.getChildLocalPosition(avgX, avgZ);

            const key = MapObjectSpawner.instance.getKey(parent);
            if (!key) continue;
            key.node.setPosition(pos.x, pos.y, pos.z);
            key.node.setRotationFromEuler(0, 0, 0);
            key.node.setScale(1, 1, 1);
            console.log('[spawnKeys] spawned key at localPos=', pos, 'worldPos=', key.node.worldPosition,
                ' prefabKey wired=', !!MapObjectSpawner.instance.prefabKey);
        }
    }

    // ─── Wall (static decor) ─────────────────────────────────────────────────────

    /** Port 1:1 từ Unity MapGenerator.SpawnWalls:
     *  Mỗi WallData → 1 Wall đặt tại centroid của GridPoints, scale theo sqrt(count):
     *  9 → 2.2x, 4 → 1.5x, else 1x. Không có damage/HP logic — Wall thuần visual. */
    private spawnWalls(data: LevelData, parent: Node): void {
        const walls = data.PixelImage?.walls?.Walls;
        if (!walls || walls.length === 0) return;

        for (const wallData of walls) {
            if (!wallData.GridPoints || wallData.GridPoints.length === 0) continue;

            // Centroid của GridPoints
            let sumX = 0, sumZ = 0;
            for (const pt of wallData.GridPoints) { sumX += pt.x; sumZ += pt.y; }
            const avgX = sumX / wallData.GridPoints.length;
            const avgZ = sumZ / wallData.GridPoints.length;
            const pos = this.boardScaler.getChildLocalPosition(avgX, avgZ);

            const wall = MapObjectSpawner.instance.getWall(parent);
            if (!wall) continue;

            // Scale theo sqrt(count) — Unity dùng (int) cast = truncate (không round).
            // 9 grid → 3 → 2.2x; 4 grid → 2 → 1.5x; else → 1x.
            const sideLen = Math.floor(Math.sqrt(wallData.GridPoints.length));
            let s = 1;
            if (sideLen === 3) s = 2.2;
            else if (sideLen === 2) s = 1.5;
            wall.node.setScale(s, s, s);
            wall.node.setPosition(pos.x, pos.y, pos.z);
            wall.node.setRotationFromEuler(0, 0, 0);
        }
    }

    // ─── Creator (Bobbin Creator) ───────────────────────────────────────────────

    /** Port 1:1 từ Unity MapGenerator.SpawnCreators:
     *  Mỗi PixelPipeData → 1 Creator đặt tại centroid của GridPoints.
     *  Creator lắng nghe Yarn.onDespawned để spawn yarn mới khi yarn cùng material bị bắn. */
    private spawnCreators(data: LevelData, parent: Node): void {
        const pipes = data.PixelImage?.pixelPipes?.Pipes;
        if (!pipes || pipes.length === 0) return;

        for (const pipe of pipes) {
            if (!pipe.GridPoints || pipe.GridPoints.length === 0) continue;
            if (!pipe.Queue || pipe.Queue.length === 0) continue;

            // Centroid của GridPoints
            let sumX = 0, sumZ = 0;
            for (const pt of pipe.GridPoints) { sumX += pt.x; sumZ += pt.y; }
            const avgX = sumX / pipe.GridPoints.length;
            const avgZ = sumZ / pipe.GridPoints.length;
            const pos = this.boardScaler.getChildLocalPosition(avgX, avgZ);

            const creator = MapObjectSpawner.instance.getCreator(parent);
            if (!creator) continue;
            creator.node.setPosition(pos.x, pos.y, pos.z);
            creator.node.setRotationFromEuler(0, 0, 0);
            creator.node.setScale(1, 1, 1);
            creator.setup(pipe, parent);
        }
    }

    // ─── Barrier ─────────────────────────────────────────────────────────────────

    /** Port 1:1 từ Unity MapGenerator.SpawnBarriers:
     *  Mỗi GateData → 1 Barrier đặt sao cho BarrierTail (đuôi) khớp với centroid của GridPoints.
     *  Hướng rotation từ Direction (Up/Right/Down/Left). Scale tổng từ sqrt(GridPoints.length). */
    private spawnBarriers(data: LevelData, parent: Node): void {
        const gates = data.PixelImage?.gates?.Gates;
        if (!gates || gates.length === 0) return;

        for (const gate of gates) {
            if (!gate.GridPoints || gate.GridPoints.length === 0) continue;

            // Centroid của GridPoints
            let sumX = 0, sumZ = 0;
            for (const pt of gate.GridPoints) { sumX += pt.x; sumZ += pt.y; }
            const avgX = sumX / gate.GridPoints.length;
            const avgZ = sumZ / gate.GridPoints.length;
            const centroid = this.boardScaler.getChildLocalPosition(avgX, avgZ);

            const barrier = MapObjectSpawner.instance.getBarrier(parent);
            if (!barrier) continue;

            // Rotation từ Direction. Cocos KHÔNG flip X như Unity → Right/Left phải mirror so
            // với Unity values: Unity Right (90°) chỉ về +X world, nhưng +X world Unity = -X
            // world Cocos (vì BoardScaler không flip pixel.x). Up/Down theo trục Z không đổi.
            let rotY = 0;
            switch (gate.Direction) {
                case FacingDirection.Up:    rotY = 0;    break;
                case FacingDirection.Right: rotY = -90;  break;   // Unity 90  → Cocos -90
                case FacingDirection.Down:  rotY = 180;  break;
                case FacingDirection.Left:  rotY = 90;   break;   // Unity 270 → Cocos 90
            }
            barrier.node.setRotationFromEuler(0, rotY, 0);

            // Tính tailOffset = rot * BarrierTail.localPosition để đặt barrier sao cho TAIL khớp centroid.
            // Áp rotation lên tail.localPosition bằng cách tính thủ công với góc Y.
            const tailLocal = barrier.BarrierTail ? barrier.BarrierTail.position : new Vec3();
            const rad = rotY * Math.PI / 180;
            const cos = Math.cos(rad), sin = Math.sin(rad);
            const tailOffX = cos * tailLocal.x + sin * tailLocal.z;
            const tailOffZ = -sin * tailLocal.x + cos * tailLocal.z;
            barrier.node.setPosition(centroid.x - tailOffX, centroid.y, centroid.z - tailOffZ);
            barrier.node.setScale(1, 1, 1);

            // Unity dùng (int) cast = truncate, KHÔNG round. Vd sqrt(8)=2.83 → Unity 2, KHÔNG 3.
            const sideLen = Math.floor(Math.sqrt(gate.GridPoints.length));
            barrier.setScale(sideLen);
            barrier.material = gate.Material;
            barrier.score = gate.Count;
            barrier.setBarrierBody(gate.Length);
            barrier.setBarrierHeadPosition(gate.Length);
            const color = MaterialPalette.getMaterialById(gate.Material).color;
            barrier.setColor(color);
            barrier.initScoreSteps();
        }
    }

    /** Port 1:1 từ Unity MapGenerator.SpawnConnections.
     *  Data có dạng list các CẶP (ShooterIds: [a, b]) → xây adjacency graph → BFS gom cluster
     *  → mỗi cluster spawn 1 Connection + ConnectionChild cho từng cặp trong cluster. */
    private spawnConnections(data: LevelData): void {
        const connections = data.ConnectedShooters?.Connections;
        if (!connections || connections.length === 0) return;

        // 1. Build adjacency graph từ list các cặp
        const adj: Map<number, Set<number>> = new Map();
        for (const conn of connections) {
            if (!conn.ShooterIds || conn.ShooterIds.length < 2) continue;
            const a = conn.ShooterIds[0], b = conn.ShooterIds[1];
            if (!adj.has(a)) adj.set(a, new Set());
            if (!adj.has(b)) adj.set(b, new Set());
            adj.get(a).add(b);
            adj.get(b).add(a);
        }

        // 2. BFS để nhóm bobbin thành cluster (bobbin liên thông)
        const visited: Set<number> = new Set();
        const clusters: Set<number>[] = [];
        for (const startId of adj.keys()) {
            if (visited.has(startId)) continue;
            const cluster: Set<number> = new Set();
            const queue: number[] = [startId];
            visited.add(startId);
            while (queue.length > 0) {
                const cur = queue.shift()!;
                cluster.add(cur);
                for (const neighbor of adj.get(cur)!) {
                    if (visited.has(neighbor)) continue;
                    visited.add(neighbor);
                    queue.push(neighbor);
                }
            }
            clusters.push(cluster);
        }

        const parent = this.underParent ?? this.node;

        // 3. Mỗi cluster → 1 Connection + ConnectionChild cho từng pair
        let clusterIdx = 0;
        for (const cluster of clusters) {
            const members: Bobbin[] = [];
            for (const id of cluster) {
                const bobbinNode = this.idToBobbin.get(id);
                if (!bobbinNode) continue;
                const b = bobbinNode.getComponent(Bobbin);
                if (b) members.push(b);
            }
            if (members.length === 0) continue;

            const pairs: Array<[Bobbin, Bobbin]> = [];
            for (const conn of connections) {
                if (!conn.ShooterIds || conn.ShooterIds.length < 2) continue;
                const idA = conn.ShooterIds[0], idB = conn.ShooterIds[1];
                if (!cluster.has(idA)) continue;
                const bA = this.idToBobbin.get(idA)?.getComponent(Bobbin);
                const bB = this.idToBobbin.get(idB)?.getComponent(Bobbin);
                if (!bA || !bB) continue;
                pairs.push([bA, bB]);
            }

            const connNode = MapObjectSpawner.instance.getConnection(parent);
            connNode.name = `ConnectionGroup_${clusterIdx++}`;
            const connComp = connNode.getComponent(Connection) ?? connNode.addComponent(Connection);
            connComp.setup(members, pairs);
        }
    }

    /** Port 1:1 từ Unity MapGenerator.SpawnMysteryShooter:
     *  với mỗi ShooterId trong SurpriseShooters → gọi Bobbin.setMystery() để che màu + bật icon "?". */
    private spawnMysteryShooters(data: LevelData): void {
        if (!data.SurpriseShooters || !data.SurpriseShooters.ShooterIds) return;

        for (let id of data.SurpriseShooters.ShooterIds) {
            const bobbinNode = this.idToBobbin.get(id);
            if (!bobbinNode) continue;

            const bobbin = bobbinNode.getComponent(Bobbin);
            if (bobbin) bobbin.setMystery();
        }
    }

    public clearMap(): void {
        if (this.aboveParent) this.aboveParent.removeAllChildren();
        if (this.underParent) this.underParent.removeAllChildren();
        this.idToBobbin.clear();
    }
}
