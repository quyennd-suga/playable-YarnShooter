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

/** Port 1:1 từ Unity ShooterPipeData: 1 Pipe thay thế bobbin ShooterId trong grid queue.
 *  Khi Pipe trở thành head → sinh từng bobbin trong Queue.shooters tuần tự, rồi shrink+release. */
export interface ShooterPipeData {
    ShooterId: number;       // ID bobbin placeholder mà Pipe thay thế
    Queue: ShooterQueueData; // queue các ShooterData mà Pipe sẽ sinh tuần tự
}

export interface ShooterPipesData {
    Pipes: ShooterPipeData[];
}

/** Port 1:1 từ Unity PixelHealthData — đánh dấu pixel ở (x,y) là BobbinWall với HP=health.
 *  BobbinWall sẽ lấy areaX/areaY/material từ PixelData tại cùng (x,y) trong pixels[]. */
export interface PixelHealthData {
    x: number;
    y: number;
    health: number;
}

/** Port 1:1 từ Unity GridPointData — 1 pixel position. */
export interface GridPointData {
    x: number;
    y: number;
}

/** Port 1:1 từ Unity KeyData — 1 Key chiếm nhiều pixel, đặt tại centroid. */
export interface KeyData {
    GridPoints: GridPointData[];
}

/** Port 1:1 từ Unity KeysData wrapper. */
export interface KeysData {
    Keys: KeyData[];
}

/** Port 1:1 từ Unity FacingDirection enum (Barrier rotation). */
export enum FacingDirection {
    Up = 0,
    Right = 1,
    Down = 2,
    Left = 3,
}

/** Port 1:1 từ Unity GateData — 1 Barrier với hướng + length + HP. */
export interface GateData {
    GridPoints: GridPointData[];   // pixels phủ; centroid = vị trí đặt BarrierTail
    Direction: FacingDirection;    // hướng quay barrier
    Length: number;                // độ dài thân
    Material: number;              // màu match với bobbin
    Count: number;                 // HP — số lần bị đập trước khi vỡ
}

/** Port 1:1 từ Unity GatesData wrapper. */
export interface GatesData {
    Gates: GateData[];
}

/** Port 1:1 từ Unity PixelPipePixelGroupData — 1 group màu+count trong queue của Creator. */
export interface PixelPipePixelGroupData {
    Material: number;
    Count: number;
}

/** Port 1:1 từ Unity PixelPipeData — 1 Creator (Bobbin Creator) với queue tuần tự các group. */
export interface PixelPipeData {
    GridPoints: GridPointData[];        // pixels phủ; centroid = vị trí Creator
    Queue: PixelPipePixelGroupData[];   // queue group tuần tự
}

/** Port 1:1 từ Unity PixelPipesData wrapper. */
export interface PixelPipesData {
    Pipes: PixelPipeData[];
}

/** Port 1:1 từ Unity SurprisePixelsData — danh sách pixel (x,y) bị "hidden" (Mystery Yarn).
 *  Khi yarn spawn ở (x,y) trong list này → SetHidden() → hiển thị visual "?" thay vì màu thật.
 *  Reveal khi yarn lân cận bị bắn (shake propagation). */
export interface SurprisePixelsData {
    Pixels: GridPointData[];
}

/** Port 1:1 từ Unity WallData — chướng ngại vật TĨNH thuần visual trên above layer.
 *  Không có HP, không có material, không có interaction với bobbin/yarn. Centroid của
 *  GridPoints = vị trí spawn. Scale theo sqrt(GridPoints.length) (1/1.5/2.2x). */
export interface WallData {
    GridPoints: GridPointData[];
}

export interface WallsData {
    Walls: WallData[];
}

export interface PixelImage {
    pixels: PixelData[];
    pixelHealths?: PixelHealthData[];
    keys?: KeysData;
    gates?: GatesData;
    pixelPipes?: PixelPipesData;
    surprisePixels?: SurprisePixelsData;
    walls?: WallsData;
    // TODO: Add scarves etc. when needed
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
    ShooterPipes?: ShooterPipesData;
}
