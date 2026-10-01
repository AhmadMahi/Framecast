cask "framecast" do
  arch arm: "arm64", intel: "x64"

  version "1.4.0"
  sha256 arm:   :no_check,
         intel: :no_check

  url "https://github.com/AhmadMahi/Framecast/releases/download/v#{version}/Framecast-#{arch}.dmg"
  name "Framecast"
  desc "Creator-focused screen recorder with auto-zoom, cursor effects, and more"
  homepage "https://github.com/AhmadMahi/Framecast"

  livecheck do
    url :url
    strategy :github_latest
  end

  app "Framecast.app"

  zap trash: [
    "~/Library/Application Support/Framecast",
    "~/Library/Preferences/dev.framecast.app.plist",
    "~/Library/Saved Application State/dev.framecast.app.savedState",
  ]
end
