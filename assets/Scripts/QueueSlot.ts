import { _decorator, Component, Node } from 'cc';
const { ccclass, property } = _decorator;

/// Đánh dấu vị trí slot trong bottom queue. Giống Unity QueueSlot.
@ccclass('QueueSlot')
export class QueueSlot extends Component {
    @property(Node) public positionBobbin: Node = null;
}
