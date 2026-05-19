import { Node } from 'cc';
import { Bobbin } from '../Bobbin';
import { Lock } from '../Lock';
import { Pipe } from '../Pipe';

/** Port 1:1 từ Unity QueueItemType. */
export enum QueueItemType {
    Bobbin = 0,
    Pipe = 1,
    Lock = 2,
    Mover = 3,   // chưa port — placeholder cho tương lai
}

/**
 * Wrapper thống nhất cho mọi item trong grid queue (Bobbin, Lock, Pipe, Mover).
 * Port 1:1 từ Unity QueueItem.cs.
 *
 * Cách dùng:
 *   const item = QueueItem.fromBobbin(b);
 *   if (item.type === QueueItemType.Bobbin) item.bobbin.setActiveState(true);
 *   const pos = item.node.position;  // accessor thống nhất cho transform/position
 */
export class QueueItem {
    public readonly type: QueueItemType;
    public readonly bobbin: Bobbin | null;
    public readonly lock: Lock | null;
    public readonly pipe: Pipe | null;
    // Mover sẽ thêm khi port

    private constructor(type: QueueItemType, bobbin: Bobbin | null, lock: Lock | null, pipe: Pipe | null) {
        this.type = type;
        this.bobbin = bobbin;
        this.lock = lock;
        this.pipe = pipe;
    }

    /** Node accessor thống nhất — dùng cho position/transform của bất kỳ loại item nào. */
    public get node(): Node | null {
        if (this.bobbin) return this.bobbin.node;
        if (this.lock) return this.lock.node;
        if (this.pipe) return this.pipe.node;
        return null;
    }

    public static fromBobbin(b: Bobbin): QueueItem {
        return new QueueItem(QueueItemType.Bobbin, b, null, null);
    }

    public static fromLock(l: Lock): QueueItem {
        return new QueueItem(QueueItemType.Lock, null, l, null);
    }

    public static fromPipe(p: Pipe): QueueItem {
        return new QueueItem(QueueItemType.Pipe, null, null, p);
    }
}
