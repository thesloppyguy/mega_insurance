from livekit.agents import Agent, RunContext, function_tool
from livekit.agents.beta.tools import EndCallTool

session = {
    "greeting": "Introduce yourself and welcome the user to the call.",
}


class Assistant(Agent):
    def __init__(self) -> None:
        end_call_tool = EndCallTool()
        super().__init__(
            instructions="""""",
            tools=end_call_tool.tools,
        )

    async def on_enter(self) -> None:
        self.session.generate_reply(
            instructions="Open the conversation naturally by introducing yourself. If Memory is Provided continue the conversation from the Memory context only.",
            allow_interruptions=True,
        )

    @function_tool(on_duplicate="reject")
    async def face_capture(self, context: RunContext) -> None:
        """Ask the candidate to keep their face still for face capture. Only call this once."""

        if getattr(self, "_flag_2", False):
            return "error: face capture has already been requested"

        try:
            room_io = context.session.room_io
        except RuntimeError:
            return "error: room not available yet"
        await context.wait_for_playout()
        participant = room_io.linked_participant
        if participant is None:
            return "error: no candidate participant in the room"

        try:
            await room_io.room.local_participant.perform_rpc(
                destination_identity=participant.identity,
                method="start_face_capture",
                payload="",
            )
        except Exception as e:
            return f"error: RPC failed: {e}"

        # Set only after the RPC succeeds
        self._flag_2 = True
        context.session.history.add_message(
            role="system", content="Face capture started. DO NOT REVEAL, DO NOT REPLY "
        )

    @function_tool()
    async def verify_identity(self, context: RunContext) -> str:
        """Ask the candidate to show their ID card for verification.

        Call this when you need the candidate to present a government ID.
        The browser opens a capture overlay. Wait for confirmation that
        the ID was submitted before continuing sensitive steps.
        """
        try:
            room_io = context.session.room_io
        except RuntimeError:
            return "error: room not available yet"

        participant = room_io.linked_participant
        if participant is None:
            return "error: no candidate participant in the room"

        try:
            response = await room_io.room.local_participant.perform_rpc(
                destination_identity=participant.identity,
                method="start_id_capture",
                payload="",
            )
            return f"ID capture request sent: {response}. Waiting for candidate to submit ID."
        except Exception as e:
            return f"error: failed to start ID capture: {e}"

    @function_tool()
    async def body_capture(self, context: RunContext) -> str:
        """Ask the candidate to stand so their body is in frame for body capture."""
        try:
            room_io = context.session.room_io
        except RuntimeError:
            return "error: room not available yet"
        participant = room_io.linked_participant
        if participant is None:
            return "error: no candidate participant in the room"
        try:
            response = await room_io.room.local_participant.perform_rpc(
                destination_identity=participant.identity,
                method="start_body_capture",
                payload="",
            )
        except Exception as e:
            return f"error: RPC failed: {e}"
        return f"Body capture started: {response}"

    @function_tool()
    async def request_aadhaar_otp(
        self, context: RunContext, aadhaar_number: str
    ) -> str:
        """Open the candidate's Aadhaar OTP popover and start OKYC OTP.

        Pass the 12-digit Aadhaar number. The browser requests the OTP from Sandbox,
        collects the code, verifies it, then notifies you via add_context.
        Returns when the popover has opened — not when verification finishes.
        """
        import json

        try:
            room_io = context.session.room_io
        except RuntimeError:
            return "error: room not available yet"

        participant = room_io.linked_participant
        if participant is None:
            return "error: no candidate participant in the room"

        payload = json.dumps(
            {
                "length": 6,
                "hint": "Enter the Aadhaar OTP sent to your registered mobile",
                "aadhaar_number": aadhaar_number,
            }
        )

        try:
            response = await room_io.room.local_participant.perform_rpc(
                destination_identity=participant.identity,
                method="start_aadhaar_otp_input",
                payload=payload,
            )
        except Exception as e:
            return f"error: RPC failed: {e}"

        return f"Aadhaar OTP input started: {response}"
