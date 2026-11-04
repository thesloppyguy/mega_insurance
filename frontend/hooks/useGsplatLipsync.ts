"use client";

import type { Room } from "livekit-client";
import { RoomEvent } from "livekit-client";
import { useEffect, useRef } from "react";
import {
	FLAME_TOPIC,
	FlameFeed,
	parseFlamePacket,
} from "@/lib/optimodel/flame-feed";
import { lipsyncMark } from "@/lib/optimodel/lipsync-metrics";

const LIPSYNC_TOPIC = "avatar.lipsync";

type TurnMarker = {
	type: "turn_start" | "audio_start" | "turn_end";
	turn_id: string;
};

/**
 * OptiModel (arkit) lipsync: the voice worker generates FLAME keyframes and
 * streams them over LiveKit data. This hook only routes them into a
 * `FlameFeed`; agent audio is played by the normal `RoomAudioRenderer`.
 */
export function useGsplatLipsync(room: Room | null): {
	flameFeed: FlameFeed;
} {
	const flameFeedRef = useRef(new FlameFeed());
	const flameFeed = flameFeedRef.current;

	useEffect(() => {
		if (!room) {
			return;
		}

		const onData = (
			payload: Uint8Array,
			_participant: unknown,
			_kind: unknown,
			topic?: string,
		) => {
			if (topic === FLAME_TOPIC) {
				const packet = parseFlamePacket(payload);
				if (packet) {
					flameFeed.push(packet);
				}
				return;
			}
			if (topic !== LIPSYNC_TOPIC) {
				return;
			}
			let marker: TurnMarker;
			try {
				marker = JSON.parse(new TextDecoder().decode(payload));
			} catch {
				return;
			}
			lipsyncMark(marker.type, { turnId: marker.turn_id });
			switch (marker.type) {
				case "turn_start":
					flameFeed.begin(marker.turn_id);
					break;
				case "audio_start":
					flameFeed.audioStart(marker.turn_id);
					break;
				case "turn_end":
					flameFeed.end(marker.turn_id);
					break;
			}
		};

		room.on(RoomEvent.DataReceived, onData);
		return () => {
			room.off(RoomEvent.DataReceived, onData);
			flameFeed.end();
		};
	}, [room, flameFeed]);

	return { flameFeed };
}
