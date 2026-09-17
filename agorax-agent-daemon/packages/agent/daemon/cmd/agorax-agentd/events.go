package main

import (
	"encoding/json"
	"sync"
)

type eventHub struct {
	mu sync.Mutex
	subs map[chan []byte]struct{}
}

func newEventHub() *eventHub { return &eventHub{subs: make(map[chan []byte]struct{})} }

func (h *eventHub) subscribe() (chan []byte, func()) {
	channel := make(chan []byte, 32)
	h.mu.Lock()
	h.subs[channel] = struct{}{}
	h.mu.Unlock()
	return channel, func() {
		h.mu.Lock()
		delete(h.subs, channel)
		close(channel)
		h.mu.Unlock()
	}
}

func (h *eventHub) publish(value any) {
	payload, err := json.Marshal(map[string]any{"kind": "event", "event": value})
	if err != nil { return }
	h.mu.Lock()
	defer h.mu.Unlock()
	for channel := range h.subs {
		select { case channel <- payload: default: }
	}
}
