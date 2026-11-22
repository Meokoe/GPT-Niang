$script:bubbleVoiceEnabled = $true
$script:bubbleVoiceStyle = 'fish'
$script:bubbleVoiceSpeed = 100
$script:bubbleVoiceKleeUnavailable = $false
$script:bubbleVoice = $null

function Initialize-WidgetBubbleVoiceSettings($Settings) {
    if ($Settings.bubbleVoiceEnabled -is [bool]) { $script:bubbleVoiceEnabled = $Settings.bubbleVoiceEnabled }
    if ($Settings.bubbleVoiceStyle -cin @('fish','lumo','klee')) { $script:bubbleVoiceStyle = $Settings.bubbleVoiceStyle }
    $speed = 0
    if ([int]::TryParse([string]$Settings.bubbleVoiceSpeed, [ref]$speed) -and $speed -ge 50 -and $speed -le 200) {
        $script:bubbleVoiceSpeed = $speed
    }
}

function Stop-WidgetBubbleVoice {
    $voice = $script:bubbleVoice
    if (!$voice) { return }
    $script:bubbleVoice = $null
    $voice.Timer.Stop()
    if ($script:ui.SpeechMotion) { $script:ui.SpeechMotion.Y = 0 }
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
    try { [IO.File]::Delete($voice.TimingPath) } catch {}
}

function Update-WidgetSpeechMotion($Voice, [double]$PositionMs) {
    $motion = $script:ui.SpeechMotion
    if (!$motion -or !$Voice.Timings.Count) { return }

    $next = $Voice.BeatIndex + 1
    while ($next -lt $Voice.Timings.Count -and $Voice.Timings[$next] -le $PositionMs) {
        $Voice.BeatIndex = $next
        $next++
    }
    if ($Voice.BeatIndex -lt 0) { return }

    $start = $Voice.Timings[$Voice.BeatIndex]
    $duration = 105.0
    if ($next -lt $Voice.Timings.Count) {
        $duration = [Math]::Min($duration, ($Voice.Timings[$next] - $start) * 0.8)
    }
    $elapsed = $PositionMs - $start
    # One little hop per syllable. Reading the media clock keeps the motion
    # in sync if audio startup or a dispatcher frame is delayed.
    $motion.Y = if ($elapsed -ge 0 -and $elapsed -lt $duration) {
        -3.8 * [Math]::Sin([Math]::PI * $elapsed / $duration)
    } else { 0 }
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
    $timingPath = $path + '.timings.json'
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $node
    $start.Arguments = '"' + (Join-Path $script:appDir 'runtime\bubble-voice.mjs') + '" "' + $path + '"'
    $start.Arguments += ' --voice ' + $script:bubbleVoiceStyle + ' --speed ' + $script:bubbleVoiceSpeed
    $start.Arguments += ' --timings "' + $timingPath + '"'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardError = $true
    $timer = [Windows.Threading.DispatcherTimer]::new()
    $timer.Interval = [TimeSpan]::FromMilliseconds(40)
    $script:bubbleVoice = @{
        Path = $path
        TimingPath = $timingPath
        Timings = @()
        BeatIndex = -1
        RequestedStyle = $script:bubbleVoiceStyle
        Process = $null
        Player = $null
        Timer = $timer
        Clock = [Diagnostics.Stopwatch]::StartNew()
        DelayMs = $DelayMs
        EndAfterMs = if ($script:bubbleVoiceStyle -eq 'klee') { 18000 } else { 5000 }
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
                if ($elapsed -ge $voice.EndAfterMs) {
                    Stop-WidgetBubbleVoice
                    return
                }
                if ($voice.Player) {
                    Update-WidgetSpeechMotion $voice $voice.Player.Position.TotalMilliseconds
                    return
                }
                if (!$voice.Process.HasExited -or $elapsed -lt $voice.DelayMs) { return }
                $ok = $voice.Process.ExitCode -eq 0 -and [IO.File]::Exists($voice.Path)
                if ($voice.RequestedStyle -eq 'klee') {
                    $script:bubbleVoiceKleeUnavailable = $voice.Process.StandardError.ReadToEnd() -match 'KLEE_UNAVAILABLE'
                }
                $voice.Process.Dispose()
                $voice.Process = $null
                if (!$ok) { Stop-WidgetBubbleVoice; return }
                try {
                    $timings = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($voice.TimingPath)) -ErrorAction Stop
                    $voice.Timings = [double[]]$timings
                } catch {}
                $voice.EndAfterMs = $elapsed + 5000
                # Use WPF's player so click sounds and bubble speech have separate playback.
                $voice.Player = [Windows.Media.MediaPlayer]::new()
                $voice.Player.Volume = Get-WidgetAudioVolume
                $voice.Player.Add_MediaOpened({
                    param($player, $event)
                    $current = $script:bubbleVoice
                    if ($current -and $player -eq $current.Player -and $player.NaturalDuration.HasTimeSpan) {
                        $current.EndAfterMs = $current.Clock.Elapsed.TotalMilliseconds + $player.NaturalDuration.TimeSpan.TotalMilliseconds + 5000
                    }
                })
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
                if ($voice.Timings.Count) { $voice.Timer.Interval = [TimeSpan]::FromMilliseconds(16) }
            } catch { Stop-WidgetBubbleVoice }
        })
        $timer.Start()
    } catch { Stop-WidgetBubbleVoice }
}
