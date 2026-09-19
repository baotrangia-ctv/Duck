# Deadline Extraction Policy

## Nguyên tắc chung
- Deadline phải được trả về dưới dạng ngày chính xác theo định dạng DD/MM/YYYY.
- Dùng nội dung tin nhắn kết hợp với reference date được cung cấp theo múi giờ Asia/Ho_Chi_Minh; mọi phép cộng/trừ ngày đều tính theo reference date đó, không dùng ngày hệ thống khác.
- Thời gian trong ngày (giờ, buổi sáng/trưa/chiều/tối/đêm) không cần giữ lại trong Sheet, chỉ giữ phần ngày. Biểu thức có mốc giờ (ví dụ "4h chiều nay", "9h sáng mai") chỉ dùng để xác định NGÀY được neo tới ("nay"/"mai"), bỏ phần giờ khi trả kết quả.
- Khi tin nhắn nêu nhiều mốc thời gian, ưu tiên mốc được gắn nhãn deadline rõ ràng (theo sau/trước các từ như "deadline", "hạn chót", "hạn hoàn thành", "due date", "trước", "hoàn thành/hoàn tất vào ngày", "vào ngày") hơn các ngày xuất hiện ngẫu nhiên khác trong câu.
- Nếu tin nhắn nêu một khoảng ngày (ví dụ "từ ngày 20 đến 25/9", "20-25/9"), dùng ngày kết thúc của khoảng làm deadline.
- Nếu message không đủ thông tin để xác định một ngày hợp lệ duy nhất, trả null. Không hỏi lại, không tự suy diễn hoặc bịa ngày.

## Ngày tuyệt đối / một phần
- Định dạng số có năm (18/9/2026, 18-9-2026, 18.9.2026...): giữ nguyên, chuẩn hoá về DD/MM/YYYY.
- Định dạng số không có năm (18/9, 18-9): đây là mốc mơ hồ về năm, không phải cụm chỉ hướng thời gian. Nếu ngày đó đã qua trong năm hiện tại, dùng năm kế tiếp gần nhất còn ở tương lai; nếu chưa qua, dùng năm hiện tại.
- Ngày viết bằng chữ ("18 tháng 9", "ngày 18 tháng 9 năm 2026", "September 18", "18th of September") áp dụng đúng quy tắc như định dạng số: có năm thì giữ nguyên, không có năm thì suy ra năm gần nhất còn ở tương lai.
- "ngày 18" hoặc "18" đứng một mình (không kèm tháng) là mốc mơ hồ tương tự: dùng lần xuất hiện gần nhất của ngày 18, tính NGHIÊM NGẶT sau ngày tin nhắn. Nếu ngày 18 của tháng hiện tại đã qua hoặc trùng ngày tin nhắn, chuyển sang ngày 18 của tháng kế tiếp.

## Cụm ngày tương đối chỉ hướng rõ ràng
Các cụm dưới đây có từ chỉ hướng tường minh (nay/mai/kia/qua, này/sau/trước) nên PHẢI suy ra đúng ngày lịch tương ứng, kể cả khi rơi vào quá khứ — không mặc định đẩy về tương lai và không trả null chỉ vì đó là ngày đã qua (task có thể đang bị quá hạn, Task Priority Policy sẽ tự đánh dấu P0 cho trường hợp này).
- hôm nay / nay / today → reference date.
- ngày mai / mai / tomorrow / tmr → reference date + 1.
- ngày kia / day after tomorrow → reference date + 2.
- hôm qua / yesterday → reference date − 1.
- hôm kia / day before yesterday → reference date − 2.

## Thứ trong tuần
Một tuần được tính từ Thứ Hai đến Chủ Nhật.
- "thứ X" không kèm định ngữ tuần: mốc mơ hồ, dùng lần xuất hiện gần nhất của thứ X tính NGHIÊM NGẶT sau ngày tin nhắn (nếu trùng thứ X của hôm nay thì lấy tuần sau).
- "thứ X tuần này": thứ X trong tuần chứa ngày tin nhắn.
- "thứ X tuần sau" / "thứ X tuần tới": thứ X của tuần kế tiếp ngay sau tuần chứa ngày tin nhắn.
- "thứ X tuần sau nữa" / "thứ X của hai tuần tới": thứ X của tuần thứ hai kể từ tuần chứa ngày tin nhắn (bỏ qua một tuần ở giữa).
- "thứ X tuần trước": thứ X của tuần liền trước tuần chứa ngày tin nhắn (kết quả có thể là quá khứ, giữ nguyên theo nguyên tắc ở mục trên).

## Biểu thức theo tuần (không kèm thứ)
- "trong tuần này": Thứ Sáu của tuần chứa ngày tin nhắn.
- "trong tuần sau" / "trong tuần tới": Thứ Sáu của tuần kế tiếp.
- "trong tuần trước": Thứ Sáu của tuần liền trước.
- "tuần sau nữa" / "trong hai tuần tới": Thứ Sáu của tuần thứ hai kể từ tuần chứa ngày tin nhắn.
- "đầu tuần (này/sau/trước)": Thứ Hai của tuần tương ứng.
- "giữa tuần (này/sau/trước)": Thứ Tư của tuần tương ứng.
- "cuối tuần (này/sau/trước)" mang nghĩa ngày nghỉ: Chủ Nhật của tuần tương ứng.

## Biểu thức theo tháng
- "đầu tháng (này/sau/trước)": ngày 1 của tháng tương ứng.
- "giữa tháng (này/sau/trước)": ngày 15 của tháng tương ứng.
- "cuối tháng (này/sau/trước)": ngày cuối cùng của tháng tương ứng (28–31 tuỳ tháng).
- "tháng sau" / "tháng tới" / "tháng trước" đứng một mình, không kèm ngày cụ thể trong tháng: không đủ thông tin để chọn một ngày duy nhất, trả null.

## Số lượng ngày/tuần/tháng tương đối (đếm số)
- "trong N ngày (nữa)", "N ngày nữa", "sau N ngày": reference date + N ngày.
- "trong N tuần (nữa)", "N tuần nữa", "sau N tuần": reference date + (N × 7) ngày.
- "trong N tháng (nữa)", "N tháng nữa", "sau N tháng": cộng N tháng theo lịch, giữ nguyên ngày trong tháng; nếu tháng đích không có ngày đó (ví dụ ngày 31 rơi vào tháng chỉ có 30 ngày), dùng ngày cuối cùng của tháng đích.

## Không đủ thông tin
- Nếu không có bất kỳ biểu thức ngày/thứ/tuần/tháng nào ở trên xuất hiện, hoặc biểu thức xuất hiện nhưng không thể quy về một ngày duy nhất (ví dụ chỉ nói "sớm", "gấp", "khi nào rảnh"), trả null. Không hỏi lại và không tự suy diễn.
