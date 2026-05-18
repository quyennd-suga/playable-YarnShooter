import { _decorator, Component, JsonAsset, Node } from 'cc';
import { MaterialPalette } from './MaterialPalette';
import { BoardScaler } from './BoardScaler';
import { Yarn } from './Yarn';
import { Bobbin } from './Bobbin';
import { MapObjectSpawner } from './MapObjectSpawner';
import { LevelManager } from './Core/LevelManager';
import { GameManager } from './Core/GameManager';
import { TrayManager } from './Core/TrayManager';
import { Connection } from './Core/Connection';
import { PixelData } from './Data/LevelInterfaces';

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

            for (let i = 0; i < yarnPixels.length; i++) {
                const pixel = yarnPixels[i];
                const node = MapObjectSpawner.instance.getYarn(parent);

                const pos = this.boardScaler.getChildLocalPosition(pixel.x, pixel.y);
                node.setPosition(pos.x, pos.y, pos.z);

                node.getComponent(Yarn)?.setColor(MaterialPalette.getMaterialById(pixel.material).color);
                const yarnComp = node.getComponent(Yarn);
                if (yarnComp) {
                    yarnComp.data = pixel;
                    GameManager.instance?.registerYarn(yarnComp);
                }
            }

            // Build lookup (x,y) → PixelData để spawnBobbinWalls lấy areaX/areaY/material
            const pixelLookup = new Map<string, PixelData>();
            for (const p of pixels) pixelLookup.set(this._pixelKey(p.x, p.y), p);
            this.spawnBobbinWalls(data, pixelLookup, parent);

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

            // Port 1:1 từ Unity MapGenerator: cột được mirror theo trục X (queues.Count - 1 - qIdx).
            // Đây là convention level designer Unity đang dùng — nếu thấy lệch sau khi fix
            // có thể revert lại `qIdx * spacing` để giữ layout cũ.
            const colX = startX + (queues.length - 1 - qIdx) * this.bobbinColumnSpacing;

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

    private spawnLocks(data: LevelData): void {
        if (!data.Locks || !data.Locks.Shooters) return;
        const parent = this.underParent ?? this.node;

        for (let lockData of data.Locks.Shooters) {
            const bobbinNode = this.idToBobbin.get(lockData.ShooterId);
            if (!bobbinNode) continue;

            let lockNode = MapObjectSpawner.instance.getLock(parent);
            lockNode.name = "Lock_" + lockData.ShooterId;
            lockNode.setPosition(bobbinNode.position);

            // Xóa bobbin cũ và xóa khỏi idToBobbin vì Lock thay thế Bobbin
            bobbinNode.destroy();
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

    private spawnPipes(data: LevelData): void {
        if (!data.ShooterPipes || !data.ShooterPipes.Pipes) return;
        const parent = this.underParent ?? this.node;

        for (let pipeData of data.ShooterPipes.Pipes) {
            const bobbinNode = this.idToBobbin.get(pipeData.ShooterId);
            if (!bobbinNode) continue;

            let pipeNode = MapObjectSpawner.instance.getPipe(parent);
            pipeNode.name = "Pipe_" + pipeData.ShooterId;
            pipeNode.setPosition(bobbinNode.position);

            // Pipe cũng thay thế Bobbin
            bobbinNode.destroy();
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
