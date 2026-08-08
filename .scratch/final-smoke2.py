import os, pty, time, select, subprocess

pid, fd = pty.fork()
if pid == 0:
    os.execvp("node", ["node", "--import", "tsx", "src/cli.ts"])
    os._exit(1)
os.set_blocking(fd, False)
output = b""
start = time.time()
phase = 0
exited = False
while time.time() - start < 30:
    try:
        data = os.read(fd, 65536)
        if data:
            output += data
    except (OSError, BlockingIOError):
        pass
    if phase == 0 and time.time() - start > 7:
        os.write(fd, b"hi\r")
        phase = 1
    if phase == 1 and time.time() - start > 11:
        os.write(fd, b"/quit\r")
        phase = 2
    wpid, status = os.waitpid(pid, os.WNOHANG)
    if wpid == pid:
        exited = True
        break
    if time.time() - start > 15:
        ps = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
        print("PS at 15s:", ps or "(gone)")
        break
    time.sleep(0.05)
if not exited:
    try:
        os.kill(pid, 9)
    except ProcessLookupError:
        pass
text = output.decode("utf-8", "replace")
print("EXITED:", exited)
print("QUERY_PROCESSED:", "[HOOK] UserPromptSubmit" in text)
