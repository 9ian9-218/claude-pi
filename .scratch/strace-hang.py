import os, pty, time, select

pid, fd = pty.fork()
if pid == 0:
    os.execvp("strace", ["strace", "-f", "-tt", "-o", "/tmp/hang2.strace", "node", "--import", "tsx", "src/cli.ts"])
    os._exit(1)
os.set_blocking(fd, False)
start = time.time()
phase = 0
while time.time() - start < 17:
    try:
        os.read(fd, 65536)
    except (OSError, BlockingIOError):
        pass
    if phase == 0 and time.time() - start > 7:
        os.write(fd, b"hi\r")
        phase = 1
    wpid, status = os.waitpid(pid, os.WNOHANG)
    if wpid == pid:
        break
    time.sleep(0.05)
try:
    os.kill(pid, 9)
except ProcessLookupError:
    pass
