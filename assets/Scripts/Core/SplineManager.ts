import { _decorator, Component, Node, Vec3, tween, PhysicsSystem, geometry, Quat, Prefab, instantiate } from 'cc';
import { EventBus, GameEvents } from './EventBus';
import { Bobbin } from '../Bobbin';
import { Yarn } from '../Yarn';
import { QueueManager } from './QueueManager';
import { OverflowQueue } from './OverflowQueue';
import { RopeSimulator } from './RopeSimulator';
import { SplineCustom } from './SplineCustom';
import { TrayManager } from './TrayManager';
import { Tray } from '../Tray';

const { ccclass, property } = _decorator;

class TrayMover {
    public bobbin: Bobbin = null;
    public tray: Tray = null; // Xe Gòn chở Bobbin
    public progress: number = 0;
    public ropeReleaseTimer: number = 0;
    public currentSegIdx: number = -1;

    public hasAnchor: boolean = false;
    public nextFirePos: Vec3 = new Vec3();
    public activeRope: RopeSimulator = null;
    public lastSnapDir: Vec3 = new Vec3();
    public lastInward: Vec3 = new Vec3();

    public isFirstFrame: boolean = true;
    public steerRot: Quat = new Quat();
    public rollAngle: number = 0;
}

class PendingCheckout {
    public bobbin: Bobbin = null;
    public bobbinFlyDone: boolean = false;
    public tray: Tray = null;
    public trayArrived: boolean = false;

    // QueueTray staging (dùng khi belt không còn chỗ)
    public useQueueTray: boolean = false;
    public queueTraySlot: number = -1;
    public queueTrayTargetPos: Vec3 = new Vec3(); // vị trí staging (cao hơn startTray)
    public trayArrivedAtQueue: boolean = false;   // tray đến vị trí staging
    public readyForBelt: boolean = false;          // đã rơi xuống startTray, chờ vào belt

    // isFlying: còn đang bay đến đích (staging hay startTray)
    public get isFlying(): boolean {
        if (this.useQueueTray) return !this.bobbinFlyDone || !this.trayArrivedAtQueue;
        return !this.bobbinFlyDone || !this.trayArrived;
    }
}

@ccclass('SplineManager')
export class SplineManager extends Component {
    public static instance: SplineManager = null;

    @property(SplineCustom) public spline: SplineCustom = null;

    @property(Node) public startBobbin: Node = null;
    @property(Node) public startTray: Node = null;
    @property(Node) public yarnParent: Node = null;

    @property public maxTrays: number = 5;
    @property public turnSpeed: number = 15.0;
    @property public rollSpeed: number = 500.0;

    /** Euler offset của Tray khi chạy trên belt (chỉnh trong Inspector nếu bị lệch). */
    @property(Vec3) public trayBeltEuler: Vec3 = new Vec3(0, -90, 0);

    /** Điều chỉnh độ cao của Tray so với yần (dương = cao hơn, âm = thấp hơn).
     *  Chỉnh cho đến khi Bobbin ngồi trên Tray ngang bằng với Yarn là được. */
    @property public trayYOffset: number = 0;

    @property public queueTrayStartSpacing: number = 2.0;   // khoảng cách Y từ startBobbin lên slot đầu tiên
    @property public queueTrayBetweenSpacing: number = 1.5; // khoảng cách Y giữa các slot
    @property public queueTrayDropSpeed: number = 3.0;      // tốc độ rơi bình thường
    @property public queueTrayDropSpeedNearStart: number = 1.0; // tốc độ rơi khi gần startTray
    @property public queueTrayDropGapBetween: number = 0.3; // khoảng gap tối thiểu giữa 2 tray đang rơi
    @property public queueTraySlotCount: number = 3;        // số slot staging tối đa
    @property public bobbinFlyDuration: number = 0.4;
    @property public queueTrayMinScale: number = 0.7;
    @property public minSpacing: number = 1.5;

    @property public raycastDistance: number = 100.0;
    @property public flipRaycastSide: boolean = false;
    @property public raycastYOffset: number = 0.05;
    @property public ropeReleaseDelay: number = 0.08;
    @property(Prefab) public ropePrefab: Prefab = null;

    private _activeMovers: TrayMover[] = [];
    private _checkoutQueue: PendingCheckout[] = [];
    private _queueTrayOccupied: boolean[] = [];
    private _lastExpectedBeltEntryTime: number = 0;

    private _segLengths: number[] = [];
    private _segSnapDirs: Vec3[] = [];
    private _segInwards: Vec3[] = [];
    private _totalPathLength: number = 0;
    private _ray: geometry.Ray = new geometry.Ray();

    onLoad() {
        if (!SplineManager.instance) { SplineManager.instance = this; }
        else { this.node.destroy(); return; }

        EventBus.on(GameEvents.ON_BOBBIN_CHECKOUT, this.onBobbinCheckout, this);
    }

    start() {
        if (this.spline) {
            this.spline.rebuild();
        }
        this.rebuildSpline();
    }

    public rebuildSpline() {
        this._segLengths = [];
        this._segSnapDirs = [];
        this._segInwards = [];
        this._totalPathLength = 0;

        if (!this.spline || this.spline.wps.length < 2) return;

        let wps = this.spline.wps;

        for (let i = 0; i < wps.length - 1; i++) {
            let p1 = wps[i];
            let p2 = wps[i + 1];
            let fwd = new Vec3();
            Vec3.subtract(fwd, p2, p1);

            let len = fwd.length();
            this._segLengths.push(len);
            this._totalPathLength += len;

            let snapped = new Vec3();
            if (Math.abs(fwd.x) >= Math.abs(fwd.z)) {
                snapped = fwd.x >= 0 ? Vec3.UNIT_X.clone() : new Vec3(-1, 0, 0);
            } else {
                snapped = fwd.z >= 0 ? Vec3.UNIT_Z.clone() : new Vec3(0, 0, -1);
            }
            this._segSnapDirs.push(snapped);

            let inward = new Vec3();
            Vec3.cross(inward, snapped, Vec3.UNIT_Y);
            inward.normalize();

            if (this.flipRaycastSide) {
                inward.multiplyScalar(-1);
            }

            this._segInwards.push(inward);
        }
    }

    public hasAvailableSlot(): boolean {
        if (!TrayManager.instance?.hasAvailableTray) return false;
        // Cho phép nếu belt còn chỗ HOẶC còn slot staging (QueueTray)
        return this._hasBeltSpacing() || this._findFreeQueueTraySlot() >= 0;
    }

    private _hasBeltSpacing(): boolean {
        if (this._activeMovers.length >= this.maxTrays) return false;
        if (this._activeMovers.length > 0) {
            let lastMover = this._activeMovers[this._activeMovers.length - 1];
            if (lastMover.progress < this.minSpacing) return false;
        }
        return true;
    }

    private onBobbinCheckout(bobbin: Bobbin) {
        if (!this.startBobbin || !this.startTray || !this.spline || this.spline.wps.length < 2) {
            bobbin.shake();
            return;
        }

        // Ẩn score1 ngay khi bắt đầu bay checkout
        bobbin.onCheckoutStart();

        // Khởi tạo slot array nếu chưa có
        if (this._queueTrayOccupied.length !== this.queueTraySlotCount) {
            this._queueTrayOccupied = new Array(this.queueTraySlotCount).fill(false);
        }

        const pending = new PendingCheckout();
        pending.bobbin = bobbin;

        // Tính góc xoay đích của tray trên belt
        const targetRot = new Quat();
        if (this.spline.wps.length >= 2) {
            const dir = new Vec3();
            Vec3.subtract(dir, this.spline.wps[1], this.spline.wps[0]).normalize();
            const steerRot = new Quat();
            Quat.fromViewUp(steerRot, dir, Vec3.UNIT_Y);
            const trayBaseRot = new Quat();
            Quat.fromEuler(trayBaseRot, this.trayBeltEuler.x, this.trayBeltEuler.y, this.trayBeltEuler.z);
            Quat.multiply(targetRot, steerRot, trayBaseRot);
        }

        // Giống Unity BeginCheckoutFly: kiểm tra có chỗ trên belt không
        const hasClearance = this._hasBeltSpacing() && this._lastExpectedBeltEntryTime <= Date.now() / 1000;
        const slotIdx = hasClearance ? -1 : this._findFreeQueueTraySlot();

        if (!hasClearance && slotIdx < 0) {
            // Không còn slot staging — vẫn bay thẳng như fallback (giống Unity)
        }

        if (!hasClearance && slotIdx >= 0) {
            // Path QueueTray: bay lên vị trí staging, sau đó drop xuống
            const queuePos = this._getDynamicQueueTrayPosition();
            pending.useQueueTray = true;
            pending.queueTraySlot = slotIdx;
            pending.queueTrayTargetPos.set(queuePos);
            this._queueTrayOccupied[slotIdx] = true;
            this._advanceExpectedBeltEntry(Date.now() / 1000 + this.bobbinFlyDuration +
                (queuePos.y - this.startTray.worldPosition.y) / this.queueTrayDropSpeed);

            const ok = TrayManager.instance.tryCheckout(
                queuePos,
                (arrivedTray: Tray) => {
                    pending.tray = arrivedTray;
                    pending.trayArrivedAtQueue = true;
                },
                targetRot
            );
            if (!ok) { bobbin.shake(); return; }

            // Bay lên vị trí staging
            this._startBobbinFly(pending, queuePos.clone(), this.bobbinFlyDuration);
        } else {
            // Path trực tiếp: bay thẳng đến startTray
            this._advanceExpectedBeltEntry(Date.now() / 1000 + this.bobbinFlyDuration);

            const ok = TrayManager.instance.tryCheckout(
                this.startTray.worldPosition,
                (arrivedTray: Tray) => {
                    pending.tray = arrivedTray;
                    pending.trayArrived = true;
                },
                targetRot
            );
            if (!ok) { bobbin.shake(); return; }

            this._startBobbinFly(pending, this.startBobbin.worldPosition.clone(), this.bobbinFlyDuration);
        }

        this._checkoutQueue.push(pending);
    }

    private _advanceExpectedBeltEntry(tArrive: number) {
        const tMinEntry = this._lastExpectedBeltEntryTime + this.minSpacing / this.spline.speed;
        this._lastExpectedBeltEntryTime = Math.max(tArrive, tMinEntry);
    }

    private _findFreeQueueTraySlot(): number {
        // Tìm slot cao nhất đang có bobbin đang rơi (chưa readyForBelt)
        let maxDroppingSlot = -1;
        for (const p of this._checkoutQueue) {
            if (p.useQueueTray && p.trayArrivedAtQueue && !p.readyForBelt)
                maxDroppingSlot = Math.max(maxDroppingSlot, p.queueTraySlot);
        }
        // Ưu tiên slot cao hơn slot đang rơi thấp nhất
        if (maxDroppingSlot >= 0) {
            for (let i = maxDroppingSlot + 1; i < this._queueTrayOccupied.length; i++)
                if (!this._queueTrayOccupied[i]) return i;
        }
        for (let i = 0; i < this._queueTrayOccupied.length; i++)
            if (!this._queueTrayOccupied[i]) return i;
        return -1;
    }

    private _getDynamicQueueTrayPosition(): Vec3 {
        // Tính Y cao nhất của bobbin đang trong queue (giống Unity GetDynamicQueueTrayPosition)
        let topY = Number.NEGATIVE_INFINITY;
        for (const p of this._checkoutQueue) {
            if (!p.useQueueTray || p.readyForBelt) continue;
            const y = (p.trayArrivedAtQueue && p.tray)
                ? p.tray.node.worldPosition.y
                : p.queueTrayTargetPos.y;
            if (y > topY) topY = y;
        }
        const basePos = this.startBobbin.worldPosition;
        if (topY === Number.NEGATIVE_INFINITY)
            return new Vec3(basePos.x, basePos.y + this.queueTrayStartSpacing, basePos.z);
        return new Vec3(basePos.x, topY + this.queueTrayBetweenSpacing, basePos.z);
    }

    private _startBobbinFly(pending: PendingCheckout, endPos: Vec3, duration: number) {
        const bobbin = pending.bobbin;
        if (!bobbin?.node?.isValid) return;

        const startPos = bobbin.node.worldPosition.clone();
        const controlY = Math.max(startPos.y, endPos.y) + 2.0;

        const rotFrom = bobbin.node.rotation.clone();
        const rotTo = new Quat();
        Quat.fromEuler(rotTo, 0, 0, 90);
        const tempPos = new Vec3();
        const tempRot = new Quat();
        const tempObj = { ratio: 0 };

        tween(tempObj)
            .to(duration, { ratio: 1 }, {
                onUpdate: () => {
                    const r = tempObj.ratio, inv = 1 - r;
                    const ctrlX = (startPos.x + endPos.x) * 0.5;
                    const ctrlZ = (startPos.z + endPos.z) * 0.5;
                    tempPos.x = inv*inv*startPos.x + 2*inv*r*ctrlX + r*r*endPos.x;
                    tempPos.y = inv*inv*startPos.y + 2*inv*r*controlY + r*r*endPos.y;
                    tempPos.z = inv*inv*startPos.z + 2*inv*r*ctrlZ + r*r*endPos.z;
                    bobbin.node.setWorldPosition(tempPos);

                    const rotT = r < 0.5 ? r / 0.5 : 1.0;
                    Quat.slerp(tempRot, rotFrom, rotTo, rotT);
                    bobbin.node.setRotation(tempRot);
                }
            })
            .call(() => {
                pending.bobbinFlyDone = true;
            })
            .start();
    }

    update(dt: number) {
        this.processCheckoutQueue(dt);
        this.updateMovers(dt);
    }

    private processCheckoutQueue(dt: number) {
        // 1. Xử lý drop cho tất cả QueueTray đang staging
        for (const p of this._checkoutQueue) {
            if (!p.useQueueTray || p.isFlying || p.readyForBelt) continue;

            // Seat bobbin lên tray tại vị trí staging (1 lần) — match Unity QueueTray seat
            if (!p['_seatedAtQueue']) {
                p['_seatedAtQueue'] = true;
                const seatNode = p.tray.positionBobbin ?? p.tray.node;
                p.bobbin.node.setParent(seatNode, false);
                p.bobbin.node.setPosition(Vec3.ZERO);
                const localRot = new Quat();
                Quat.fromEuler(localRot, 0, 180, -90);
                p.bobbin.node.setRotation(localRot);
                p.bobbin.node.setScale(Vec3.ONE);
                // Hiện score2 ngay khi ngồi lên tray staging, không chờ tray rơi xuống belt
                p.bobbin.onPlacedOnBelt();
            }

            // Drop tray xuống startTray
            const trayNode = p.tray.node;
            const targetY = this.startTray.worldPosition.y;
            const currentY = trayNode.worldPosition.y;
            if (currentY <= targetY + 0.001) {
                // Đến nơi
                p.readyForBelt = true;
                this._queueTrayOccupied[p.queueTraySlot] = false;
                p.tray.spawnArrivalFx();
                continue;
            }

            // Tính speed: freeze nếu tray phía dưới đang đợi; slow nếu gần startTray
            let speed = this.queueTrayDropSpeed;
            let hasWaitingBelow = false;
            for (const other of this._checkoutQueue) {
                if (other === p || !other.useQueueTray || !other.tray) continue;
                const otherY = other.tray.node.worldPosition.y;
                if (otherY >= currentY) continue;
                // Tray phía dưới đang đợi spacing
                if (other.readyForBelt || (currentY - otherY < this.queueTrayDropGapBetween)) {
                    hasWaitingBelow = true; break;
                }
            }
            if (hasWaitingBelow) speed = 0;

            if (speed > 0) {
                const newY = Math.max(targetY, currentY - speed * dt);
                const wp = trayNode.worldPosition.clone();
                wp.y = newY;
                trayNode.setWorldPosition(wp);
            }
        }

        // 2. Seat bobbin đầu hàng lên belt khi sẵn sàng
        if (this._checkoutQueue.length === 0) return;
        const p = this._checkoutQueue[0];

        // Direct path: chờ bay xong + tray đến (spacing đã check lúc click)
        if (!p.useQueueTray) {
            if (p.isFlying) return;
        } else {
            // QueueTray path: chờ đã rơi xuống startTray, sau đó check spacing
            if (!p.readyForBelt) return;
            if (!this._hasBeltSpacing()) return;
        }

        // Seat lên belt — match Unity 1:1: localPos=0, localRot=Euler(0,180,90), localScale=1
        if (!p.useQueueTray) {
            const seatNode = p.tray.positionBobbin ?? p.tray.node;
            p.bobbin.node.setParent(seatNode, false);
            p.bobbin.node.setPosition(Vec3.ZERO);
            const beltLocalRot = new Quat();
            Quat.fromEuler(beltLocalRot, 0, 180, -90);
            p.bobbin.node.setRotation(beltLocalRot);
            p.bobbin.node.setScale(Vec3.ONE);
            p.tray.spawnArrivalFx();
        }
        // QueueTray: bobbin đã được seat từ trước, chỉ cần thêm vào belt
        p.bobbin.onPlacedOnBelt();

        this._checkoutQueue.shift();
        const mover = new TrayMover();
        mover.bobbin = p.bobbin;
        mover.tray = p.tray;
        mover.progress = 0;
        mover.currentSegIdx = -1;
        mover.isFirstFrame = true;
        mover.rollAngle = 0;
        this._activeMovers.push(mover);
    }

    private updateMovers(dt: number) {
        if (!this.spline || this.spline.wps.length < 2) return;

        let step = this.spline.speed * dt;

        for (let i = this._activeMovers.length - 1; i >= 0; i--) {
            let mover = this._activeMovers[i];

            if (!mover.bobbin || !mover.bobbin.isValid || mover.bobbin.data.ammo <= 0) {
                this.handleBobbinCompleteOnBelt(mover);
                continue;
            }

            mover.progress += step;

            if (mover.progress >= this._totalPathLength) {
                this.onMoverReachedEnd(mover, i);
                continue;
            }

            let currentDist = mover.progress;
            let segIdx = 0;
            while (segIdx < this._segLengths.length && currentDist > this._segLengths[segIdx]) {
                currentDist -= this._segLengths[segIdx];
                segIdx++;
            }
            if (segIdx >= this._segLengths.length) segIdx = this._segLengths.length - 1;

            if (segIdx !== mover.currentSegIdx) {
                mover.currentSegIdx = segIdx;
                mover.lastSnapDir = this._segSnapDirs[segIdx];
                mover.lastInward = this._segInwards[segIdx];
                mover.hasAnchor = false;
            }

            let p1 = this.spline.wps[segIdx];
            let p2 = this.spline.wps[segIdx + 1];
            let t = currentDist / this._segLengths[segIdx];

            let pos = new Vec3();
            Vec3.lerp(pos, p1, p2, t);

            if (this.yarnParent) {
                // Tray phải thấp hơn Yarn một khoảng bằng chiều cao của Tray
                // đến positionBobbin. Dùng trayYOffset để chỉnh sớn trong Inspector.
                pos.y = this.yarnParent.worldPosition.y + this.trayYOffset;
            }
            mover.tray.node.setWorldPosition(pos);

            let dir = new Vec3();
            Vec3.subtract(dir, p2, p1).normalize();
            let targetSteerRot = new Quat();
            Quat.fromViewUp(targetSteerRot, dir, Vec3.UNIT_Y);

            if (mover.isFirstFrame) {
                mover.steerRot.set(targetSteerRot);
                mover.isFirstFrame = false;
            } else {
                Quat.slerp(mover.steerRot, mover.steerRot, targetSteerRot, dt * this.turnSpeed);
            }

            // ── Tray: chỉ xoay theo hướng di chuyển, giữ phẳng nằm trên belt
            let trayBaseRot = new Quat();
            Quat.fromEuler(trayBaseRot, this.trayBeltEuler.x, this.trayBeltEuler.y, this.trayBeltEuler.z);
            let trayFinalRot = new Quat();
            Quat.multiply(trayFinalRot, mover.steerRot, trayBaseRot);
            mover.tray.node.setWorldRotation(trayFinalRot);

            // Bobbin là child của tray.positionBobbin với localRot Euler(0,180,90) cố định
            // → tự inherit rotation từ tray, không xoay riêng (giống Unity)
            if (mover.bobbin && mover.bobbin.node && mover.bobbin.node.isValid) {
                // Chỉ căn score2 đứng đúng dựa vào rotation Y của tray (giống Unity KeepScore2Upright)
                mover.bobbin.keepScore2Upright(mover.tray.node);
            }

            // Origin của tia bắn: ưu tiên bobbin.shoot (giống Unity), fallback về vị trí Tray
            const origin = (mover.bobbin.shoot)
                ? mover.bobbin.shoot.worldPosition.clone()
                : pos.clone();

            let shouldFire = true;
            if (mover.hasAnchor) {
                if (mover.lastSnapDir.x > 0.5) shouldFire = origin.x >= mover.nextFirePos.x;
                else if (mover.lastSnapDir.x < -0.5) shouldFire = origin.x <= mover.nextFirePos.x;
                else if (mover.lastSnapDir.z > 0.5) shouldFire = origin.z >= mover.nextFirePos.z;
                else if (mover.lastSnapDir.z < -0.5) shouldFire = origin.z <= mover.nextFirePos.z;
            }

            if (shouldFire) {
                let fireOrigin = origin.clone();
                if (mover.hasAnchor) {
                    if (Math.abs(mover.lastSnapDir.x) > 0.5) fireOrigin.x = mover.nextFirePos.x;
                    else fireOrigin.z = mover.nextFirePos.z;
                }
                this.fireYarnRaycast(mover, fireOrigin, mover.lastInward);
            }

            if (mover.activeRope) {
                if (!mover.hasAnchor) {
                    mover.ropeReleaseTimer += dt;
                    if (mover.ropeReleaseTimer >= this.ropeReleaseDelay && mover.bobbin.data.ammo > 0) {
                        mover.activeRope.node.destroy();
                        mover.activeRope = null;
                        mover.ropeReleaseTimer = 0;
                    }
                } else {
                    mover.ropeReleaseTimer = 0;
                }
            }
        }
    }

    private fireYarnRaycast(mover: TrayMover, origin: Vec3, inward: Vec3) {
        if (!mover.bobbin || mover.bobbin.data.ammo <= 0) return;

        let rayOriginY = origin.y + this.raycastYOffset;
        geometry.Ray.set(this._ray, origin.x, rayOriginY, origin.z, inward.x, inward.y, inward.z);
        let didHit = false;

        if (PhysicsSystem.instance.raycast(this._ray, 0xffffffff, this.raycastDistance, true)) {
            const results = PhysicsSystem.instance.raycastResults;
            results.sort((a, b) => a.distance - b.distance);

            for (let res of results) {
                let hitNode = res.collider.node;
                let yarn = hitNode.getComponent(Yarn);

                let p = hitNode.parent;
                while (!yarn && p) {
                    yarn = p.getComponent(Yarn);
                    p = p.parent;
                }

                if (yarn && yarn.data) {
                    if (yarn.data.material === mover.bobbin.data.material) {
                        this.handleYarnHit(mover, yarn, res.hitPoint, res.collider);
                        didHit = true;
                        break;
                    } else {
                        break;
                    }
                } else if (hitNode.name !== "Belt" && hitNode.name !== "Bobbin") {
                    if (!mover["_hasLoggedBlock"]) {
                        mover["_hasLoggedBlock"] = true;
                    }
                }
            }
        }

        if (!didHit) {
            mover.hasAnchor = false;
            if (!mover["_hasLoggedMiss"]) {
                mover["_hasLoggedMiss"] = true;
            }
        }
    }

    private handleYarnHit(mover: TrayMover, yarn: Yarn, hitPoint: Vec3, collider: import('cc').Collider) {
        mover.bobbin.decrementAmmo();
        mover.ropeReleaseTimer = 0;
        mover.hasAnchor = true;

        let cellSize = 1.0;
        if (collider && collider.worldBounds) {
            let he = collider.worldBounds.halfExtents;
            cellSize = Math.max(he.x, he.z) * 2.0;
        }

        let nextPos = new Vec3();
        Vec3.scaleAndAdd(nextPos, yarn.node.worldPosition, mover.lastSnapDir, cellSize);
        mover.nextFirePos = nextPos;

        let tPos = yarn.node.worldPosition.clone();
        tPos.y += this.raycastYOffset;

        mover.ropeReleaseTimer = 0;

        if (!mover.activeRope && this.ropePrefab) {
            let ropeNode = instantiate(this.ropePrefab);
            this.node.addChild(ropeNode);
            mover.activeRope = ropeNode.getComponent(RopeSimulator) || ropeNode.addComponent(RopeSimulator);
            mover.activeRope.pointA = mover.bobbin.node;
            mover.activeRope.targetPos = tPos;
            mover.activeRope.setColor(mover.bobbin.currentColor);
            mover.activeRope.forceRefresh();
        } else if (mover.activeRope) {
            mover.activeRope.targetPos = tPos;
        }

        yarn.despawn(() => yarn.node.destroy());

        if (mover.bobbin.data.ammo <= 0) {
            this.handleBobbinCompleteOnBelt(mover);
        }
    }

    private handleBobbinCompleteOnBelt(mover: TrayMover) {
        let idx = this._activeMovers.indexOf(mover);
        if (idx !== -1) {
            this._activeMovers.splice(idx, 1);
        }

        if (mover.activeRope) {
            // Delay destruction so user sees the last hit (giống Unity DelayedReleaseRope 0.1f)
            const rope = mover.activeRope;
            mover.activeRope = null;
            this.scheduleOnce(() => { if (rope?.node?.isValid) rope.node.destroy(); }, 0.1);
        }

        // Tách Bobbin ra khỏi Tray trước khi trả Tray và destroy Bobbin
        if (mover.bobbin && mover.tray) {
            mover.bobbin.node.setParent(this.node, true);
        }

        if (mover.bobbin) {
            tween(mover.bobbin.node)
                .to(0.2, { scale: Vec3.ZERO })
                .call(() => {
                    mover.bobbin.node.destroy();
                })
                .start();
        }

        // Trả chiếc xe Gòn (Tray) rỗng về lại kho của TrayManager
        if (mover.tray) {
            TrayManager.instance.returnTray(mover.tray, false);
            mover.tray = null;
        }
    }

    private onMoverReachedEnd(mover: TrayMover, idx: number) {
        if (idx !== -1) this._activeMovers.splice(idx, 1);
        if (mover.activeRope) {
            mover.activeRope.node.destroy();
            mover.activeRope = null;
        }

        // Tách Bobbin ra khỏi Tray trước khi trả Tray
        if (mover.bobbin && mover.tray) {
            mover.bobbin.node.setParent(this.node, true);
        }

        // Trả xe gòn về kho có hiệu ứng bounce
        if (mover.tray) {
            TrayManager.instance.returnTray(mover.tray, true);
            mover.tray = null;
        }

        // Thử trả về BottomQueue trước, nếu đầy thì thử OverflowQueue (giống Unity CompleteMoverEnd)
        const returned = QueueManager.instance.tryReturn(mover.bobbin);
        if (!returned) {
            if (OverflowQueue.instance?.hasSpace) {
                OverflowQueue.instance.addBobbin(mover.bobbin);
            } else {
                console.warn("[SplineManager] Game Over! Tất cả queue đầy!");
                tween(mover.bobbin.node).to(0.2, { scale: Vec3.ZERO }).call(() => mover.bobbin.node.destroy()).start();
            }
        }
    }
}
