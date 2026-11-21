$script:bubbleVoiceEnabled = $true
$script:bubbleVoice = $null

function Stop-WidgetBubbleVoice {
    $voice = $script:bubbleVoice
    if (!$voice) { return }
    $script:bubbleVoice = $null
    $voice.Timer.Stop()
    if ($voice.Player) {
        try { $voice.Player.Close() } catch {}
    }
    if ($voice.Process) {
        try {
            if (!$voice.Process.HasExited) {
                $voice.Process.Kill()
                $null = $voice.Process.WaitForExit(100)
            }
        } catch {} finally { $voice.Process.Dispose() }
    }
    try { [IO.File]::Delete($voice.Path) } catch {}
}

function Test-WidgetBubbleVoiceActive {
    return [bool]$script:bubbleVoice
}

function Set-WidgetBubbleVoiceVolume {
    $volume = Get-WidgetAudioVolume
    if ($volume -le 0) { Stop-WidgetBubbleVoice }
    elseif ($script:bubbleVoice -and $script:bubbleVoice.Player) {
        $script:bubbleVoice.Player.Volume = $volume
    }
}

function Start-WidgetBubbleVoice([string]$Text, [int]$DelayMs = 0) {
    Stop-WidgetBubbleVoice
    if (!$script:bubbleVoiceEnabled -or (Get-WidgetAudioVolume) -le 0 -or [string]::IsNullOrWhiteSpace($Text)) { return }
    $node = [string]$script:config.nodePath
    if (!$node) { return }
    $path = Join-Path ([IO.Path]::GetTempPath()) ('gpt-niang-bubble-' + [Guid]::NewGuid().ToString('N') + '.wav')
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $node
    $start.Arguments = '"' + (Join-Path $script:appDir 'runtime\bubble-voice.mjs') + '" "' + $path + '"'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $timer = [Windows.Threading.DispatcherTimer]::new()
    $timer.Interval = [TimeSpan]::FromMilliseconds(40)
    $script:bubbleVoice = @{
        Path = $path
        Process = $null
        Player = $null
        Timer = $timer
        Clock = [Diagnostics.Stopwatch]::StartNew()
        DelayMs = $DelayMs
    }
    try {
        $script:bubbleVoice.Process = [Diagnostics.Process]::Start($start)
        $inputBytes = [Text.Encoding]::UTF8.GetBytes($Text)
        $stream = $script:bubbleVoice.Process.StandardInput.BaseStream
        try { $stream.Write($inputBytes, 0, $inputBytes.Length) } finally { $stream.Close() }
        $timer.Add_Tick({
            param($sender, $event)
            $voice = $script:bubbleVoice
            if (!$voice -or $sender -ne $voice.Timer) { $sender.Stop(); return }
            try {
                # A hung synthesizer or audio device must not keep a bubble open.
                $elapsed = $voice.Clock.Elapsed.TotalMilliseconds
                if ($elapsed -ge 65000 -or ($voice.Process -and $elapsed -ge 4000 -and !$voice.Process.HasExited)) {
                    Stop-WidgetBubbleVoice
                    return
                }
                if ($voice.Player -or !$voice.Process.HasExited -or $elapsed -lt $voice.DelayMs) { return }
                $ok = $voice.Process.ExitCode -eq 0 -and [IO.File]::Exists($voice.Path)
                $voice.Process.Dispose()
                $voice.Process = $null
                if (!$ok) { Stop-WidgetBubbleVoice; return }
                # Use WPF's player so click sounds and bubble speech have separate playback.
                $voice.Player = [Windows.Media.MediaPlayer]::new()
                $voice.Player.Volume = Get-WidgetAudioVolume
                $voice.Player.Add_MediaEnded({
                    param($player, $event)
                    if ($script:bubbleVoice -and $player -eq $script:bubbleVoice.Player) { Stop-WidgetBubbleVoice }
                })
                $voice.Player.Add_MediaFailed({
                    param($player, $event)
                    if ($script:bubbleVoice -and $player -eq $script:bubbleVoice.Player) { Stop-WidgetBubbleVoice }
                })
                $voice.Player.Open([Uri]::new($voice.Path))
                $voice.Player.Play()
            } catch { Stop-WidgetBubbleVoice }
        })
        $timer.Start()
    } catch { Stop-WidgetBubbleVoice }
}
