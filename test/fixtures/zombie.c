/* Test-only parent retains its exited child until stdin closes. */
#include <stdio.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

int main(void) {
    pid_t child = fork();
    if (child < 0) return 2;
    if (child == 0) _exit(0);
    printf("%ld\n", (long)child);
    fflush(stdout);
    while (getchar() != EOF) {}
    return waitpid(child, NULL, 0) == child ? 0 : 2;
}
