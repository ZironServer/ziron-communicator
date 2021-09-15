/*
Author: Luca Scaringella
GitHub: LucaCode
Copyright(c) Luca Scaringella
 */

import {Writable} from "../Utils";

interface Entry {
    size: number;
    value: any;
    next: Entry | null;
}

export default class LinkedBuffer {

    private head: Entry | null = null;
    private tail:  Entry | null = null;

    readonly size: number = 0;
    readonly length: number = 0;

    shift() {
        if(this.length === 0) return;

        const entry = this.head;
        if (this.length === 1) this.head = this.tail = null;
        else this.head = entry!.next;

        (this as Writable<LinkedBuffer>).size -= entry!.size;
        --(this as Writable<LinkedBuffer>).length;
        return entry!.value;
    }

    push(value: ArrayBuffer | any, size: number) {
        const entry: Entry = {
            size,
            value,
            next: null
        };
        (this as Writable<LinkedBuffer>).size += entry.size;
        if(this.length > 0) this.tail!.next = entry;
        else this.head = entry;
        this.tail = entry;
        ++(this as Writable<LinkedBuffer>).length;
    }
}