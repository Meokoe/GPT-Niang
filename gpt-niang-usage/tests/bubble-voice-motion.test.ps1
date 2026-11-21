$ErrorActionPreference='Stop'
Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase
$appDir=Split-Path $PSScriptRoot -Parent
. (Join-Path $appDir 'runtime\bubble-voice.ps1')
$window=[Windows.Markup.XamlReader]::Parse([IO.File]::ReadAllText((Join-Path $appDir 'widget.xaml'),[Text.Encoding]::UTF8))
$motion=$window.FindName('SpeechMotion')
$task=$window.FindName('TaskMotion')
$script:ui=@{SpeechMotion=$motion}
$voice=@{BeatIndex=-1;Timings=@(20,85,260);Timer=[Windows.Threading.DispatcherTimer]::new()}
function Assert($condition,$message){if(!$condition){throw $message}}
try{
  $script:bubbleVoice=$voice
  $task.Y=-2
  Update-WidgetSpeechMotion $voice 19
  Assert ($motion.Y-eq 0) 'The first pulse waits for the first audio onset.'
  Update-WidgetSpeechMotion $voice 45
  Assert ($motion.Y-lt -3 -and $task.Y-eq -2) 'Speech adds motion independently of the task reaction.'
  Update-WidgetSpeechMotion $voice 80
  Assert ($motion.Y-eq 0) 'The first pulse finishes before the next syllable at fast speed.'
  Update-WidgetSpeechMotion $voice 109
  Assert ($motion.Y-lt -2 -and $voice.BeatIndex-eq 1) 'The next syllable starts a fresh pulse.'
  Update-WidgetSpeechMotion $voice 220
  Assert ($motion.Y-eq 0) 'The gap between sentences is still.'
  Update-WidgetSpeechMotion $voice 300
  Assert ($motion.Y-lt -3 -and $voice.BeatIndex-eq 2) 'The next sentence follows its audio onset.'
  Stop-WidgetBubbleVoice
  Assert ($motion.Y-eq 0 -and $task.Y-eq -2) 'Stopping speech immediately clears only the speech motion.'
  Write-Output 'PASS: syllable-driven motion, fast speech, sentence gaps and cancellation'
}finally{
  Stop-WidgetBubbleVoice
  $window.Close()
}
