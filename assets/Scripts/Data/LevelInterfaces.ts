export interface PixelData {
    x: number;
    y: number;
    material: number;
    areaX?: number;
    areaY?: number;
}

export interface Vector2Int {
    x: number;
    y: number;
}

export interface ShooterData {
    id: number;
    material: number;
    ammo: number;
}

export interface ShooterQueueData {
    shooters: ShooterData[];
}

export interface QueueGroupData {
    queues: ShooterQueueData[];
}

export interface IdListWrapper {
    ShooterIds: number[];
}

/** Một cặp bobbin được nối với nhau (port 1:1 từ Unity ConnectedShooterData).
 *  ShooterIds phải có đúng 2 phần tử = 2 bobbin id. */
export interface ConnectionPair {
    Id?: number;
    ShooterIds: number[];
}

export interface ConnectionWrapper {
    Connections: ConnectionPair[];
}

export interface IceBlockData {
    ShooterId: number;
    IceBlockCount: number;
}

export interface FrozenShootersData {
    IceBlocks: IceBlockData[];
}

export interface LockData {
    Shooters: { ShooterId: number }[];
}

export interface MowerData {
    Shooters: { ShooterId: number }[];
}

export interface PipeShooterData {
    Pipes: { ShooterId: number, ColorIndex: number }[];
}

export interface PixelImage {
    pixels: PixelData[];
    // TODO: Add healths, gates, keys, scarves etc. when needed
}

export interface LevelData {
    levelId: number;
    PixelImage: PixelImage;
    QueueGroup: QueueGroupData;
    ConnectedShooters?: ConnectionWrapper;
    SurpriseShooters?: IdListWrapper;
    FrozenShooters?: FrozenShootersData;
    Locks?: LockData;
    Mowers?: MowerData;
    ShooterPipes?: PipeShooterData;
}
