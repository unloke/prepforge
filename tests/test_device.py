"""Tests for CUDA detection.

The critical behaviour: ``has_cuda_gpu`` must return True only when torch can
*actually* allocate on the GPU. A bare ``torch.cuda.is_available()`` returning
True while the first real allocation raises (broken driver/runtime pairing, or a
GPU whose compute capability this torch build lacks kernels for) must be treated
as "no GPU" — otherwise Maia3 is handed a ``cuda`` device it cannot load onto,
which crashes Brilliant detection for new players.
"""
import sys
import types

import pytest

from prepforge_chess.services import device


@pytest.fixture(autouse=True)
def _clear_cache():
    device.has_cuda_gpu.cache_clear()
    yield
    device.has_cuda_gpu.cache_clear()


def _fake_torch(*, is_available: bool, probe_raises: bool):
    torch = types.ModuleType("torch")

    class _Tensor:
        def __add__(self, other):
            return self

        def sum(self):
            return self

        def item(self):
            if probe_raises:
                raise RuntimeError("No CUDA GPUs are available")
            return 1.0

    def zeros(*args, **kwargs):
        if probe_raises:
            raise RuntimeError("No CUDA GPUs are available")
        return _Tensor()

    torch.zeros = zeros
    torch.cuda = types.SimpleNamespace(is_available=lambda: is_available)
    return torch


def _install(monkeypatch, torch_module):
    monkeypatch.setitem(sys.modules, "torch", torch_module)


def test_no_torch_means_no_gpu(monkeypatch):
    # Maia3 requires torch; without it there is no usable GPU to report.
    monkeypatch.setitem(sys.modules, "torch", None)
    assert device.has_cuda_gpu() is False
    assert device.preferred_maia_device() == "cpu"


def test_cuda_not_available(monkeypatch):
    _install(monkeypatch, _fake_torch(is_available=False, probe_raises=False))
    assert device.has_cuda_gpu() is False
    assert device.preferred_maia_device() == "cpu"


def test_is_available_but_probe_fails_is_treated_as_no_gpu(monkeypatch):
    # The false-positive case: capability check passes, real allocation crashes.
    _install(monkeypatch, _fake_torch(is_available=True, probe_raises=True))
    assert device.has_cuda_gpu() is False
    assert device.preferred_maia_device() == "cpu"


def test_usable_cuda(monkeypatch):
    _install(monkeypatch, _fake_torch(is_available=True, probe_raises=False))
    assert device.has_cuda_gpu() is True
    assert device.preferred_maia_device() == "cuda"
