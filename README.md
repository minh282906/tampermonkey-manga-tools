# 📚 Manga Downloaders

![Tampermonkey](https://img.shields.io/badge/Tampermonkey-Supported-20B2AA?style=for-the-badge&logo=tampermonkey)
![JavaScript](https://img.shields.io/badge/JavaScript-ES6+-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)
![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)

Bộ công cụ **Tampermonkey Userscripts** hỗ trợ tải ngầm, giải mã ma trận 4x4 ảnh bị xáo trộn và đóng gói file ZIP truyện tranh độ phân giải cao từ **hơn 40+ trang web đọc manga nổi tiếng tại Nhật Bản**.

---

## ⚡ Cài Đặt Nhanh (1-Click Install)

_(Yêu cầu trình duyệt đã cài đặt tiện ích mở rộng [Tampermonkey](https://www.tampermonkey.net/))_

Bấm vào link **[Cài đặt]** tương ứng để cài đặt trực tiếp từng bên vào Tampermonkey (hoặc bạn có thể bấm vào [đây](https://github.com/minh282906/tampermonkey-manga-tools/releases/latest/download/MangaDownloader.user.js) để có toàn bộ):

| Script                           | Các trang hỗ trợ                                                                                             |  Trạng thái  |                                                     Cài Đặt (1-Click)                                                     |
| :------------------------------- | :-------------------------------------------------------------------------------------------------------------- | :-------------: | :---------------------------------------------------------------------------------------------------------------------------: |
| **EbookJapan Downloader**  | EbookJapan (`ebookjapan.yahoo.co.jp`)                                                                         | 🟢 Hoạt động |   [Cài đặt](https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/EbookJPDownloader.user.js)   |
| **BookWalker Downloader**  | BookWalker (`bookwalker.jp`)                                                                                  | 🟢 Hoạt động | [Cài đặt](https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/BookWalkerDownloader.user.js) |
| **Piccoma Downloader**     | Piccoma (`piccoma.com`)                                                                                       | 🟢 Hoạt động |   [Cài đặt](https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/PiccomaDownloader.user.js)   |
| **Comici+ Downloader**     | Champion Cross, Comic Growl, Young Champion, Young Animal, Rimacomi+, HERO'S Web..._(~30 sites)_              | 🟢 Hoạt động |   [Cài đặt](https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/Comici+Downloader.user.js)   |
| **GigaViewer Downloader**  | ShonenJump+, Sunday Webry, Comic Days, Kurage Bunch, MAGCOMI, Comic Gardo, Comic Zenon..._(20+ sites)_        | 🟢 Hoạt động | [Cài đặt](https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/GigaViewerDownloader.user.js) |
| **SpeedBinb Downloader**   | Bao gồm các nền tảng sử dụng SpeedBinb (Booklive, Comic C'moA, Yanmaga, Gaugau Futabanet, ...)                   | 🟢 Hoạt động |  [Cài đặt](https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/SpeedBinbDownloader.user.js)  |
| **Square Enix Downloader** | Bao gồm các bên thuộc Square Enix (Gangan Online, Manga Up, Shounen Gangan, GFantasy, Gangan Joker, Young Gangan, Big Gangan, ...) | 🟢 Hoạt động |  [Cài đặt](https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/SquareEnixDownloader.user.js)  |
| **ComicWalker Downloader** | (`comic-walker.com`)                                                                                          | 🟢 Hoạt động | [Cài đặt](https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/ComicWalkerDownloader.user.js) |
| **MangaOne Downloader**    | Manga ONE (`manga-one.com`)                                                                                   | 🟢 Hoạt động |  [Cài đặt](https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/MangaOneDownloader.user.js)  |
| **Niconico Downloader**    | (`manga.nicovideo.jp`) <br> (`sp.manga.nicovideo.jp`)                                                           | 🟢 Hoạt động |  [Cài đặt](https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/NiconicoDownloader.user.js)  |
| **JumpRookie Downloader**  | (`rookie.shonenjump.com`)                                                                                     | 🟢 Hoạt động |  [Cài đặt](https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/JumpRookieDownloader.user.js)  |
| **Comici Downloader**      | (`comici.jp`)                                                                                                 | 🟢 Hoạt động |  [Cài đặt](https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/ComiciJPDownloader.user.js)  |
| **Amazon Downloader**      | (`amazon.co.jp`)                                                                                              | 🟢 Hoạt động |   [Cài đặt](https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/AmazonDownloader.user.js)   |

---

## 🔥 Tính Năng Nổi Bật

- 🚀 **Tải song song siêu tốc (Parallel Queue):** Tải đồng thời 4-6 luồng ảnh giúp tiết kiệm thời gian tối đa mà không gây nghẽn băng thông.
- 🧩 **Giải mã chuẩn 100%:** Tự động khôi phục các trang ảnh bị xáo trộn ma trận (Scramble / Matrix Transpose) hoặc ảnh bị mã hóa (XOR) về đúng nguyên bản.
- 📦 **Nén ZIP nguyên bản (Pure Zip Writer):** Đóng gói file ZIP trực tiếp trong bộ nhớ RAM không cần qua server trung gian hay thư viện ngoài.
- 🔄 **Tự động thích ứng chuyển Chap (SPA Route Watcher):** Tự động dọn dẹp bộ nhớ RAM và cập nhật dữ liệu khi bấm chuyển Chap mà không cần refresh trang.
- 🎨 **Giao diện riêng biệt cho từng Script:** Bảng UI thu gọn đính ở góc trên bên phải với tông màu nhận diện thương hiệu riêng biệt cho từng nền tảng.
- 🏷️ **Phân loại ảnh thông minh:**
  - Trang truyện chính: Đánh số thứ tự tăng dần `1.png`, `2.png`, `3.png`...
  - Trang bìa mở đầu / Quảng cáo thương mại: Tự động lưu nguyên bản không nén lại thành `PR.jpg` hoặc `PR_1.jpg`, `PR_2.jpg`...
  - Tên file ZIP lưu chuẩn định dạng: `{Tên Truyện} - {Tên Chap}.zip`.

---

## 🌐 Danh Sách Các Web Được Hỗ Trợ

<details>
<summary><b>Click để xem chi tiết ~30 trang Nền tảng Comici+</b></summary>

- Champion Cross (`championcross.jp`)
- Comic Growl (`comic-growl.com`)
- Young Champion (`youngchampion.jp`)
- Young Animal (`younganimal.com`)
- Hana to Yume (`hanayume.com`)
- Big Comics (`bigcomics.jp`)
- Rimacomi+ (`rimacomiplus.jp`)
- HERO'S Web (`heros-web.com`)
- Takecomic (`takecomic.jp`)
- Hayacomic (`hayacomic.jp`)
- MAGKAN (`kansai.mag-garden.co.jp`)
- COMIC MeDu (`g-comi.jp`)
- Comic PASH! (`comicpash.jp`)
- KimiComi (`kimicomi.com`)
- Comic Room Base (`comic-room-base.com`)
- Comirela (`comirela.com`)
- BiBiBi Comic (`bibibi-comic.com`)
- Mangalt (`mangalt.jp`)
- Comici Comic (`comics.comici.jp`)
- Comic Ride (`comicride.jp`)
- Manga Bang Comics (`comics.manga-bang.com`)
- MangaSPA! (`mangaspa.nikkan-spa.jp`)
- Asacomi (`asacomi.jp`)
- NamiComic (`namicomic.jp`)
- Pia Comic (`piacomic.jp`)
- Comic J&N (`comic.j-nbooks.jp`)
- booklistaSTUDIOweb (`studio.booklista.co.jp`)
- Manga Zegra (`manga-zegra.com`)

</details>

<details>
<summary><b>Click để xem chi tiết 20+ trang Nền tảng GigaViewer</b></summary>

- Shonen Jump+ (`shonenjumpplus.com`)
- Tonari no Young Jump (`tonarinoyj.jp`)
- Sunday Webry (`sunday-webry.com`)
- Comic Days (`comic-days.com`)
- Kurage Bunch (`kuragebunch.com`)
- MAGCOMI (`magcomi.com`)
- Comic Gardo (`comic-gardo.com`)
- Comic Zenon (`comic-zenon.com`)
- Web Action (`comic-action.com`)
- Comic Trail (`comic-trail.com`)
- Feel Web (`feelweb.jp`)
- Comic Earth Star (`comic-earthstar.com`)
- Comic Border (`comicborder.com`)
- COMIC OGYAAA!! (`comic-ogyaaa.com`)
- Comic Seasons (`comic-seasons.com`)
- COMIC Y-OURS (`comic-y-ours.com`)
- Ichicomi (`ichicomi.com`)
- Manga Time Square (`mangatime-square.com`)
- OUR FEEL (`ourfeel.jp`)
- &Sofa (`andsofa.com`)
- Morning two (`morningtwo.com`)
- 月マガ基地 (`getsumagakichi.com`)
- Biblio Sirius (`bibliosirius.com`)
- Comic Bunch Kai (`comicbunch-kai.com`)

</details>

<details>
<summary><b>Click để xem chi tiết các trang thuộc Square Enix</b></summary>

- Gangan Online (`ganganonline.com`)
- Manga UP! (`manga-up.com`)
- Shounen Gangan (`magazine.jp.square-enix.com/gangan`)
- GFantasy (`magazine.jp.square-enix.com/gfantasy`)
- Gangan Joker (`magazine.jp.square-enix.com/joker`)
- Big Gangan (`magazine.jp.square-enix.com/biggangan`)
- Young Gangan (`magazine.jp.square-enix.com/yg`)
- Ngoài ra còn sự kiện của Square Enix (Comics Party) (`magazine.jp.square-enix.com/comiweb`)

</details>

- EbookJP (`ebookjapan.yahoo.co.jp`)
- Comic C'moA (`cmoa.jp`)
- BookWalker Manga (`bookwalker.jp`)
- Piccoma Manga (`piccoma.com`)
- MagaPoke (`pocket.shonenmagazine.com`)
- Yanmaga Web (`yanmaga.jp`)
- ComicWalker (`comic-walker.com`)
- Niconico Manga (`manga.nicovideo.jp`)
- Gaugau Futabanet Manga (`gaugau.futabanet.jp`)
- Jump Rookie (`rookie.shonenjump.com`)
- Comici (`comici.jp`)
- Amazon Kindle Manga (`amazon.co.jp`)

</details>

---

## 🛠️ Dành Cho Lập Trình Viên & Đóng Góp (Contribution)

Rất hoan nghênh sự đóng góp (Pull Request) cải tiến code từ cộng đồng!

### Quy trình phát triển:

1. Clone dự án về máy:
   ```bash
   git clone https://github.com/minh282906/tampermonkey-manga-tools.git
   cd manga-downloaders
   ```
2. Chỉnh sửa code trực tiếp trong thư mục
3. Kiểm tra script chạy thử trên Tampermonkey.
4. Tạo **Pull Request** lên nhánh `main`.

---

## 🐛 Báo Lỗi & Yêu Cầu Tính Năng

Nếu bạn gặp trang web bị lỗi, không tải được ảnh hoặc muốn đóng góp ý tưởng mới, vui lòng gửi báo lỗi tại:

**[Tạo Issue Báo Lỗi Mới](https://github.com/minh282906/tampermonkey-manga-tools/issues/new)**

---

## ⚠️ Tuyên Bố Miễn Trừ Trách Nhiệm (Disclaimer)

Bộ script này được phát triển phục vụ cho mục đích học tập, nghiên cứu cá nhân và lưu trữ cá nhân.
Tác giả không chịu trách nhiệm cho bất kỳ hành vi phát tán thương mại hay vi phạm bản quyền tác phẩm nào của người sử dụng. Hãy ủng hộ tác giả bằng cách mua truyện bản quyền trên trang web chính thức!

---

## 📜 Giấy Phép (License)

Dự án được phân phối dưới giấy phép **[MIT License](LICENSE)**.
