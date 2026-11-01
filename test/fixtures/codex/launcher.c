/* Test-only executable: replace this process with the isolated fake, never Codex. */
#include <stdlib.h>
#include <unistd.h>

int main(int argc, char **argv) {
    char *node = getenv("CODEX_FIXTURE_NODE");
    char *entry = getenv("CODEX_FIXTURE_ENTRY");
    if (!node || !entry) return 2;
    char **args = calloc((size_t)argc + 2, sizeof(char *));
    if (!args) return 2;
    args[0] = node;
    args[1] = entry;
    for (int i = 1; i < argc; i++) args[i + 1] = argv[i];
    execv(node, args);
    return 2;
}
