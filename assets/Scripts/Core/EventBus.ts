import { EventTarget } from 'cc';

export const EventBus = new EventTarget();

export const GameEvents = {
    ON_BOBBIN_CLICKED: 'ON_BOBBIN_CLICKED',
    ON_BOBBIN_CHECKOUT: 'ON_BOBBIN_CHECKOUT',
    ON_BOBBIN_REACHED_TRAY: 'ON_BOBBIN_REACHED_TRAY',
    ON_YARN_HIT: 'ON_YARN_HIT'
};
