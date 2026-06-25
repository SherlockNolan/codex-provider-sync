namespace CodexProviderSync.Core.Tests;

public sealed class SingleInstanceGuardTests
{
    private static (string lockDir, string settingsRoot) NewIsolatedLockDir()
    {
        string root = Path.Combine(Path.GetTempPath(), $"codex-provider-singleton-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        string lockDir = Path.Combine(root, "singleton");
        return (lockDir, root);
    }

    private static void Cleanup(string settingsRoot)
    {
        try
        {
            if (Directory.Exists(settingsRoot))
            {
                Directory.Delete(settingsRoot, recursive: true);
            }
        }
        catch
        {
            // best-effort
        }
    }

    [Fact]
    public void Acquire_FirstCallerIsOwner_AndLockDirectoryExists()
    {
        (string lockDir, string settingsRoot) = NewIsolatedLockDir();
        try
        {
            SingleInstanceGuard guard = new(_ => false, lockDir);
            using SingleInstanceAcquisition acquisition = guard.Acquire("test");
            Assert.True(acquisition.IsOwner);
            Assert.Null(acquisition.ExistingOwner);
            Assert.Equal(lockDir, guard.LockDirectory);
            Assert.True(Directory.Exists(lockDir));
            Assert.True(File.Exists(Path.Combine(lockDir, "owner.json")));
        }
        finally
        {
            Cleanup(settingsRoot);
        }
    }

    [Fact]
    public void Acquire_SecondCallerSeesExistingOwner_WhenFirstIsAlive()
    {
        (string lockDir, string settingsRoot) = NewIsolatedLockDir();
        try
        {
            // First call takes the lock. We then mutate owner.json to
            // advertise a different (synthetic) pid so the test simulates a
            // different process holding the lock — within a single test
            // process we cannot Acquire twice as owner (the guard's
            // stale-recovery path would treat the first as a self-stale).
            SingleInstanceGuard first = new(_ => true, lockDir);
            using SingleInstanceAcquisition firstAcq = first.Acquire("first");
            Assert.True(firstAcq.IsOwner);

            string ownerPath = Path.Combine(lockDir, "owner.json");
            string ownerJson = File.ReadAllText(ownerPath);
            File.WriteAllText(ownerPath, ownerJson.Replace(
                $"\"processId\": {Environment.ProcessId}",
                "\"processId\": 99999"));

            SingleInstanceGuard second = new(_ => true, lockDir);
            using SingleInstanceAcquisition secondAcq = second.Acquire("second");
            Assert.False(secondAcq.IsOwner);
            Assert.NotNull(secondAcq.ExistingOwner);
            Assert.Equal(99999, secondAcq.ExistingOwner!.ProcessId);
            Assert.Equal("first", secondAcq.ExistingOwner.Label);
        }
        finally
        {
            Cleanup(settingsRoot);
        }
    }

    [Fact]
    public void Acquire_RecoversFromStaleLock_WhenPreviousOwnerIsDead()
    {
        (string lockDir, string settingsRoot) = NewIsolatedLockDir();
        try
        {
            // First acquisition is "abandoned" without being disposed.
            SingleInstanceGuard stale = new(_ => true, lockDir);
            SingleInstanceAcquisition staleAcq = stale.Acquire("stale");
            Assert.True(staleAcq.IsOwner);
            // Pretend the stale owner died by leaving the dir on disk.
            staleAcq.Dispose();

            // New acquisition must observe a dead owner (probe returns false) and
            // recover by taking the lock itself.
            SingleInstanceGuard fresh = new(_ => false, lockDir);
            using SingleInstanceAcquisition freshAcq = fresh.Acquire("fresh");
            Assert.True(freshAcq.IsOwner);
        }
        finally
        {
            Cleanup(settingsRoot);
        }
    }

    [Fact]
    public void Dispose_RemovesLockDirectoryForOwner()
    {
        (string lockDir, string settingsRoot) = NewIsolatedLockDir();
        try
        {
            SingleInstanceGuard guard = new(_ => false, lockDir);
            using (guard.Acquire("owner"))
            {
                Assert.True(Directory.Exists(lockDir));
            }
            Assert.False(Directory.Exists(lockDir));
        }
        finally
        {
            Cleanup(settingsRoot);
        }
    }

    [Fact]
    public void Acquire_RecoversWhenPreviousLockContainsLeftoverFile()
    {
        (string lockDir, string settingsRoot) = NewIsolatedLockDir();
        try
        {
            // First call takes the lock with a live probe, then we abandon it
            // (Dispose). Dispose() removes the lock directory, so we recreate
            // it manually and drop a stray file inside to simulate a partial
            // cleanup. The second call has the probe say "dead", so the guard
            // has to clear the entire tree (including the stray file) and
            // reclaim the lock.
            SingleInstanceGuard first = new(_ => true, lockDir);
            SingleInstanceAcquisition firstAcq = first.Acquire("first");
            firstAcq.Dispose();
            Directory.CreateDirectory(lockDir);
            File.WriteAllText(Path.Combine(lockDir, "BLOCK"), "leftover");

            SingleInstanceGuard second = new(_ => false, lockDir);
            using SingleInstanceAcquisition secondAcq = second.Acquire("second");
            Assert.True(secondAcq.IsOwner);
            Assert.False(File.Exists(Path.Combine(lockDir, "BLOCK")));
        }
        finally
        {
            Cleanup(settingsRoot);
        }
    }
}
