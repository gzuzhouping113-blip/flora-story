module.exports = {
  content: ["./public/flora_story.html"],
  theme: {
    extend: {
      fontFamily: {
        serif: ['"Noto Serif SC"', "serif"]
      },
      colors: {
        background: "#F5F5F7",
        primary: {
          DEFAULT: "#D2A5B3",
          light: "#F6EBED",
          dark: "#A67684"
        },
        surface: "rgba(255, 255, 255, 0.65)"
      },
      boxShadow: {
        glass: "0 8px 32px -4px rgba(0, 0, 0, 0.05)",
        glow: "0 8px 25px -5px rgba(210, 165, 179, 0.4)",
        polaroid: "0 15px 35px -5px rgba(0, 0, 0, 0.15)"
      }
    }
  }
};
