"""Deterministic worker protocol checks without Vosk or microphone access."""

import importlib.util
import io
import json
import pathlib
import unittest

spec = importlib.util.spec_from_file_location(
    "vosk_worker", pathlib.Path(__file__).with_name("vosk-worker.py")
)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class Recognizer:
    def __init__(self):
        self.steps = iter([False, False, True, False])
        self.partials = iter(["hola", "hola mundo", "otra"])

    def AcceptWaveform(self, chunk):
        return next(self.steps)

    def PartialResult(self):
        return json.dumps({"partial": next(self.partials)})

    def Result(self):
        return json.dumps({"text": "hola mundo"})

    def FinalResult(self):
        return json.dumps({"text": "otra frase"})


class WorkerTests(unittest.TestCase):
    def test_replaces_partials_and_accumulates_only_finalized_segments(self):
        messages = []
        worker.recognize(io.BytesIO(bytes(16000)), Recognizer(), messages.append)
        self.assertEqual(messages, [
            {"type": "partial", "text": "hola"},
            {"type": "partial", "text": "hola mundo"},
            {"type": "partial", "text": "hola mundo otra"},
            {"type": "final", "text": "hola mundo otra frase"},
        ])

    def test_rejects_incomplete_pcm_sample(self):
        with self.assertRaisesRegex(ValueError, "PCM16"):
            worker.recognize(io.BytesIO(b"x"), Recognizer(), lambda _: None)


if __name__ == "__main__":
    unittest.main()
