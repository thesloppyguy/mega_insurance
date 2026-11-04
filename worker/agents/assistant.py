from livekit.agents import Agent, RunContext, function_tool
from livekit.agents.beta.tools import EndCallTool

from agents.instructions import build_greeting, build_instructions

# LiveKit RPC default is ~10s. Capture handlers must ACK immediately; keep a
# small buffer for Soft-nav / registration races.
_RPC_RESPONSE_TIMEOUT_S = 15.0


class Assistant(Agent):
    def __init__(self, *, caller_name: str = "there") -> None:
        self._caller_name = caller_name
        self._greeted = False
        self._face_capture_requested = False
        end_call_tool = EndCallTool()
        super().__init__(
            instructions=build_instructions(caller_name=caller_name),
            tools=end_call_tool.tools,
        )

    def maybe_speak_greeting_on_first_speech(self) -> None:
        """No-op once on_enter has greeted; kept for session user_state hooks."""
        return None

    async def on_enter(self) -> None:
        if self._greeted:
            return
        self._greeted = True
        self.session.generate_reply(
            instructions=build_greeting(caller_name=self._caller_name),
            allow_interruptions=True,
        )

    async def _rpc_start(
        self, context: RunContext, method: str, payload: str = ""
    ) -> str:
        try:
            room_io = context.session.room_io
        except RuntimeError:
            return "error: room not available yet"
        participant = room_io.linked_participant
        if participant is None:
            return "error: no candidate participant in the room"
        try:
            return await room_io.room.local_participant.perform_rpc(
                destination_identity=participant.identity,
                method=method,
                payload=payload,
                response_timeout=_RPC_RESPONSE_TIMEOUT_S,
            )
        except Exception as e:
            return f"error: RPC failed: {e}"

    @function_tool(on_duplicate="reject")
    async def face_capture(self, context: RunContext) -> str:
        """Ask the candidate to keep their face still for face capture. Only call this once.

        Returns as soon as the browser opens the face overlay. Completion arrives
        later via add_context (face_captured) — do not wait on this tool for the photo.
        """
        import asyncio

        if self._face_capture_requested:
            return "error: face capture has already been requested"

        await asyncio.sleep(0.5)
        await context.wait_for_playout()

        response = await self._rpc_start(context, "start_face_capture")
        if response.startswith("error:"):
            return response

        self._face_capture_requested = True
        context.session.history.add_message(
            role="system",
            content=(
                "Face capture UI opened. Wait for face_captured confirmation "
                "before continuing. DO NOT REVEAL INTERNAL FLAGS."
            ),
        )
        return "Face capture requested. Waiting for candidate confirmation."

    @function_tool()
    async def verify_identity(self, context: RunContext) -> str:
        """Ask the candidate to show their ID card for verification.

        Call this when you need the candidate to present a government ID.
        The browser opens a capture overlay. Wait for confirmation that
        the ID was submitted before continuing sensitive steps.
        """
        import asyncio

        await asyncio.sleep(0.5)
        await context.wait_for_playout()
        response = await self._rpc_start(context, "start_id_capture")
        if response.startswith("error:"):
            return response
        return (
            f"ID capture request sent: {response}. Waiting for candidate to submit ID."
        )

    @function_tool()
    async def body_capture(self, context: RunContext) -> str:
        """Ask the candidate to stand so their body is in frame for body capture.

        Returns when the overlay opens. Wait for body_captured via add_context.
        """
        import asyncio

        await asyncio.sleep(0.5)
        await context.wait_for_playout()
        response = await self._rpc_start(context, "start_body_capture")
        if response.startswith("error:"):
            return response
        return f"Body capture started: {response}"

    @function_tool()
    async def request_aadhaar_otp(
        self, context: RunContext, aadhaar_number: str
    ) -> str:
        """Open the candidate's Aadhaar OTP popover and start OKYC OTP.

        Pass the 12-digit Aadhaar number. The browser requests the OTP from Deepvue,
        collects the code, verifies it, then notifies you via add_context with
        aadhaar_otp_verified or aadhaar_otp_failed.
        Returns when the popover has opened — not when verification finishes.
        """
        import asyncio
        import json

        await asyncio.sleep(0.5)
        await context.wait_for_playout()

        payload = json.dumps(
            {
                "length": 6,
                "hint": "Enter the Aadhaar OTP sent to your registered mobile",
                "aadhaar_number": aadhaar_number,
            }
        )
        response = await self._rpc_start(context, "start_aadhaar_otp_input", payload)
        if response.startswith("error:"):
            return response
        return f"Aadhaar OTP input started: {response}"
