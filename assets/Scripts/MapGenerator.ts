import { _decorator, Component, JsonAsset, Node } from 'cc';
import { MaterialPalette } from './MaterialPalette';
import { BoardScaler } from './BoardScaler';
import { Yarn } from './Yarn';
import { Bobbin } from './Bobbin';
import { MapObjectSpawner } from './MapObjectSpawner';
import { LevelManager } from './Core/LevelManager';
import { GameManager } from './Core/GameManager';
import { TrayManager } from './Core/TrayManager';

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

        // 1. Generate Above Layer (Yarns)
        if (data.PixelImage && data.PixelImage.pixels) {
            const pixels = data.PixelImage.pixels;
            this.boardScaler.calculateCenter(pixels);

            const parent = this.aboveParent ?? this.node;

            for (let i = 0; i < pixels.length; i++) {
                const pixel = pixels[i];
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

    private spawnConnections(data: LevelData): void {
        if (!data.ConnectedShooters || !data.ConnectedShooters.Connections) return;
        const parent = this.underParent ?? this.node;

        for (let i = 0; i < data.ConnectedShooters.Connections.length; i++) {
            const conn = data.ConnectedShooters.Connections[i];
            let connNode = MapObjectSpawner.instance.getConnection(parent);
            connNode.name = `ConnectionGroup_${i}`;

            // Placeholder: Đánh dấu các bobbin thuộc group connection này
            for (let id of conn.ShooterIds) {
                const bobbinNode = this.idToBobbin.get(id);
                if (bobbinNode) {
                    let markNode = new Node("Conn_Mark");
                    bobbinNode.addChild(markNode);
                }
            }
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
